// Provider-dispatched seed readers for placement tests (migration 00085).
//
// SERVER-ONLY — imported by placement-runner.ts (and nothing client-side).
// One job: given a seed inbox and a probe's RFC Message-ID, report where the
// probe landed in that seed, in a provider-neutral shape. The runner never
// talks to Gmail/Graph/IMAP for seed reads directly anymore — it goes through
// readerFor(seed, ctx).findProbe(...).
//
// Error contract (parity with the original Gmail-only path):
//   - SeedReadAuthError  → the seed's credentials/consent are broken. The
//     runner benches the seed (status='error') and marks the row 'unreadable'.
//   - anything else      → transient; the row stays 'pending' for the next
//     pass (until PLACEMENT_TIMEOUT_MS, when the runner gives up as
//     'unreadable' without benching).
//
// Seeds are read-only instruments: every reader is a pure lookup — no
// mark-read, no move, no rescue (see memory: project_no_warmup_pool_deliberate).

import type {
  PlacementAuthResults,
  SeedGraphAuth,
  SeedImapAuth,
  SeedInboxWithAuth,
} from "@/types/app";
import { GmailAuthError, type GmailClient } from "@/lib/gmail/client";
import type { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;
import {
  classifyGraphPlacement,
  classifyImapPlacement,
  classifyPlacement,
  parseAuthenticationResults,
  stripMessageIdBrackets,
} from "./placement";
import { findProbeViaImap, ImapAuthError } from "@/lib/imap/client";
import { MsGraphClient, MsGraphAuthError } from "@/lib/msgraph/client";

/** Benches the seed (status='error') and marks the result row 'unreadable'. */
export class SeedReadAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedReadAuthError";
  }
}

export type PlacementBucket = "inbox" | "promotions" | "spam" | "other";

export type ProbeLookup =
  | { found: false }
  | {
      found: true;
      bucket: PlacementBucket;
      /** Provider-shaped evidence for the results row's `labels` column. */
      labels: string[];
      authResults: PlacementAuthResults;
    };

export interface SeedReader {
  /**
   * Look up the probe by RFC Message-ID (stored WITH angle brackets).
   * Throws SeedReadAuthError → bench the seed; any other throw = transient.
   */
  findProbe(seed: SeedInboxWithAuth, rfcMessageId: string): Promise<ProbeLookup>;
}

export interface ReaderContext {
  admin: AdminClient; // the graph reader persists rotated refresh tokens (session 2)
  /** Org DWD client — required for google_workspace seeds. */
  gmail: GmailClient | null;
  /** Org-level Entra app credentials — required for microsoft_graph seeds. */
  msApp: { clientId: string; clientSecret: string } | null;
}

export function readerFor(seed: SeedInboxWithAuth, ctx: ReaderContext): SeedReader {
  switch (seed.provider) {
    case "google_workspace":
      return new WorkspaceDwdReader(ctx);
    case "imap":
      return imapReader;
    case "microsoft_graph":
      return new MsGraphReader(ctx);
  }
}

// ── google_workspace: the original DWD read, verbatim behavior ───────────

class WorkspaceDwdReader implements SeedReader {
  constructor(private readonly ctx: ReaderContext) {}

  async findProbe(seed: SeedInboxWithAuth, rfcMessageId: string): Promise<ProbeLookup> {
    const gmail = this.ctx.gmail;
    if (!gmail) {
      // No DWD client for the org = our config problem, same class as a
      // broken delegation: bench rather than retry forever.
      throw new SeedReadAuthError(
        "Native email is not configured (no Google service account), so Workspace seeds can't be read.",
      );
    }
    let found;
    try {
      found = await gmail.listMessages(
        seed.email_address,
        `rfc822msgid:${stripMessageIdBrackets(rfcMessageId)}`,
        5,
        true, // include spam/trash — the whole point is finding it in SPAM
      );
    } catch (err) {
      throw mapGmailError(err, seed.email_address);
    }
    if (found.length === 0) return { found: false };

    let msg;
    try {
      msg = await gmail.getMessage(seed.email_address, found[0].id, "metadata", [
        "Authentication-Results",
        "ARC-Authentication-Results",
      ]);
    } catch (err) {
      throw mapGmailError(err, seed.email_address);
    }
    const labels = msg.labelIds ?? [];
    const authHeader =
      msg.payload?.headers?.find((h) => h.name?.toLowerCase() === "authentication-results")
        ?.value ??
      msg.payload?.headers?.find((h) => h.name?.toLowerCase() === "arc-authentication-results")
        ?.value ??
      null;
    return {
      found: true,
      bucket: classifyPlacement(labels),
      labels: [...labels],
      authResults: parseAuthenticationResults(authHeader),
    };
  }
}

function mapGmailError(err: unknown, seedEmail: string): Error {
  if (err instanceof GmailAuthError) {
    return new SeedReadAuthError(err.message || `Delegation is broken for seed ${seedEmail}.`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

// ── imap: Yahoo, consumer Gmail, generic (app password) ──────────────────

const imapReader: SeedReader = {
  async findProbe(seed: SeedInboxWithAuth, rfcMessageId: string): Promise<ProbeLookup> {
    const auth = seed.auth as SeedImapAuth | null;
    if (!auth || !auth.host || !auth.username || !auth.password) {
      throw new SeedReadAuthError(
        `Seed ${seed.email_address} has no stored IMAP sign-in — remove it and add it again.`,
      );
    }
    let result;
    try {
      result = await findProbeViaImap(auth, rfcMessageId);
    } catch (err) {
      if (err instanceof ImapAuthError) throw new SeedReadAuthError(err.message);
      throw err instanceof Error ? err : new Error(String(err)); // transient
    }
    if (!result.found) return { found: false };

    // Evidence trail: X-GM-LABELS when Gmail gave them, else the folder name;
    // the Promotions verdict is recorded the way Gmail's own labels would be.
    const labels = result.gmLabels ?? (result.folder ? [result.folder] : []);
    if (result.promotionsHit && !labels.includes("CATEGORY_PROMOTIONS")) {
      labels.push("category:promotions");
    }
    return {
      found: true,
      bucket: classifyImapPlacement(result),
      labels,
      authResults: parseAuthenticationResults(result.authResultsHeader),
    };
  },
};

// ── microsoft_graph: Outlook.com / M365 via Graph (OAuth) ────────────────

// Per-seed access-token + folder-id cache. Access tokens live ~1h; the
// refresh token rotates on every use, so the entry also proves we've already
// persisted the rotated token this process saw. Keyed by seed id.
interface GraphCacheEntry {
  accessToken: string;
  expiresAtMs: number;
  inboxId?: string;
  junkId?: string;
}
const graphCache = new Map<string, GraphCacheEntry>();

class MsGraphReader implements SeedReader {
  constructor(private readonly ctx: ReaderContext) {}

  async findProbe(seed: SeedInboxWithAuth, rfcMessageId: string): Promise<ProbeLookup> {
    const app = this.ctx.msApp;
    if (!app) {
      throw new SeedReadAuthError(
        "The Microsoft OAuth app isn't configured — add it in Settings → Integrations, then reconnect this seed.",
      );
    }
    const auth = seed.auth as SeedGraphAuth | null;
    if (!auth?.refresh_token) {
      throw new SeedReadAuthError(
        `Seed ${seed.email_address} isn't connected to Microsoft — use the Reconnect button.`,
      );
    }
    const graph = new MsGraphClient(app.clientId, app.clientSecret);

    let accessToken: string;
    try {
      accessToken = await this.accessTokenFor(seed, auth, graph);
    } catch (err) {
      if (err instanceof MsGraphAuthError) throw new SeedReadAuthError(err.message);
      throw err instanceof Error ? err : new Error(String(err)); // transient
    }

    let msg: { id: string; parentFolderId: string } | null;
    try {
      msg = await graph.findMessageByInternetMessageId(accessToken, rfcMessageId);
    } catch (err) {
      throw mapMsError(err);
    }
    if (!msg) return { found: false };

    // Folder ids are stable per mailbox — resolve once, cache on the entry.
    const entry = graphCache.get(seed.id);
    if (entry && (!entry.inboxId || !entry.junkId)) {
      try {
        entry.inboxId = await graph.wellKnownFolderId(accessToken, "inbox");
        entry.junkId = await graph.wellKnownFolderId(accessToken, "junkemail");
      } catch (err) {
        throw mapMsError(err);
      }
    }
    const inboxId = entry?.inboxId;
    const junkId = entry?.junkId;

    let meta;
    try {
      meta = await graph.getMessageMeta(accessToken, msg.id);
    } catch (err) {
      throw mapMsError(err);
    }

    const folderName =
      meta.parentFolderId === junkId
        ? "junkemail"
        : meta.parentFolderId === inboxId
          ? "inbox"
          : "other";
    const labels: string[] = [
      folderName === "other"
        ? await graph.folderDisplayName(accessToken, meta.parentFolderId).catch(() => meta.parentFolderId)
        : folderName,
    ];
    // Focused/Other is a different axis from placement — record it, don't
    // classify it (Outlook has no Promotions).
    if (meta.inferenceClassification === "other") labels.push("focused:other");

    const authHeader =
      meta.internetMessageHeaders.find((h) => h.name.toLowerCase() === "authentication-results")
        ?.value ?? null;

    return {
      found: true,
      bucket: classifyGraphPlacement(folderName),
      labels,
      authResults: parseAuthenticationResults(authHeader),
    };
  }

  /**
   * A valid access token for the seed. Refreshes when the cached one is within
   * 60s of expiry, and — critically — PERSISTS the rotated refresh token to
   * seed_inboxes.auth before handing back the access token, because MSA
   * invalidates the old refresh token the moment it issues a new one.
   */
  private async accessTokenFor(
    seed: SeedInboxWithAuth,
    auth: SeedGraphAuth,
    graph: MsGraphClient,
  ): Promise<string> {
    const cached = graphCache.get(seed.id);
    if (cached && cached.expiresAtMs - 60_000 > Date.now()) return cached.accessToken;

    const tokens = await graph.refresh(auth.refresh_token);
    const newAuth: SeedGraphAuth = {
      refresh_token: tokens.refreshToken,
      connected_at: auth.connected_at,
    };
    const { error } = await this.ctx.admin
      .from("seed_inboxes")
      .update({ auth: newAuth })
      .eq("id", seed.id);
    if (error) {
      // Persisting the rotated token failed — do NOT use the access token
      // (the DB still holds the old, now-invalid refresh token). Transient:
      // the row stays pending and the next pass retries from a clean state.
      throw new Error(`Could not save the rotated Microsoft token: ${error.message}`);
    }
    graphCache.set(seed.id, {
      accessToken: tokens.accessToken,
      expiresAtMs: tokens.expiresAtMs,
    });
    return tokens.accessToken;
  }
}

function mapMsError(err: unknown): Error {
  if (err instanceof MsGraphAuthError) return new SeedReadAuthError(err.message);
  return err instanceof Error ? err : new Error(String(err)); // transient
}
