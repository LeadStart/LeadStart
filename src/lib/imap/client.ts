// Read-only IMAP probe lookup for external seed inboxes (migration 00085).
//
// Serves the 'imap' seed provider: Yahoo, consumer Gmail, and any generic
// mailbox reachable with an app password. The ONE hard rule mirrors the rest
// of the placement rig: seeds are measurement instruments, never participants.
// Every mailbox is opened with { readOnly: true } (IMAP EXAMINE, the server
// itself refuses flag mutations), fetches read headers/labels only (PEEK
// semantics; nothing is marked \Seen), and there is no STORE/MOVE/APPEND
// anywhere in this file. See memory: project_no_warmup_pool_deliberate.
//
// Gmail-over-IMAP is detected via the X-GM-EXT-1 capability (never hostname
// sniffing) and uses Gmail's extensions to recover the full verdict:
//   - X-GM-RAW `rfc822msgid:` search across All Mail (Spam is excluded from
//     All Mail, so Spam gets its own pass),
//   - X-GM-LABELS to tell Inbox from archived,
//   - a second `category:promotions` search for the Promotions verdict,
//     the thing plain-IMAP folder inspection can't see.
// Generic servers get an RFC 3501 HEADER Message-ID search over INBOX, then
// the junk folder (special-use \Junk first, common names as fallback).
//
// imapflow is the one external dependency (see the plan): IMAP is a stateful
// non-HTTP protocol (literals, UTF-7 mailbox names, untagged responses) and
// the house hand-rolled-fetch convention doesn't extend to it.

import { ImapFlow, type ListResponse } from "imapflow";
import type { SeedImapAuth } from "@/types/app";

/** Bad credentials / revoked app password: the caller benches the seed. */
export class ImapAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapAuthError";
  }
}

/** Network / server trouble: the caller leaves the row pending and retries. */
export class ImapTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapTransientError";
  }
}

export interface ImapProbeResult {
  found: boolean;
  /** Where the probe was found. null when found === false. */
  folder: "inbox" | "junk" | "archive" | null;
  /** X-GM-LABELS on the message (Gmail only; null on generic servers). */
  gmLabels: string[] | null;
  /** Gmail only: did a `category:promotions` search also match the probe? */
  promotionsHit: boolean | null;
  /** Raw Authentication-Results header value as the receiver recorded it. */
  authResultsHeader: string | null;
}

// A hung server must not eat a cron tick: connect, greeting, and idle-socket
// timeouts are all pinned well under the route's maxDuration.
const TIMEOUT_MS = 10_000;

function makeClient(auth: SeedImapAuth): ImapFlow {
  return new ImapFlow({
    host: auth.host,
    port: auth.port,
    secure: auth.port === 993,
    auth: { user: auth.username, pass: auth.password },
    logger: false,
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

/**
 * Connect and classify failures. imapflow marks credential rejections with
 * `authenticationFailed` on the thrown error; everything else (DNS, TLS,
 * timeouts, capacity) is transient from the placement rig's point of view.
 */
async function connectClient(auth: SeedImapAuth): Promise<ImapFlow> {
  const client = makeClient(auth);
  try {
    await client.connect();
    return client;
  } catch (err) {
    const e = err as Error & { authenticationFailed?: boolean; serverResponseCode?: string };
    const message = e.message || String(err);
    if (e.authenticationFailed || e.serverResponseCode === "AUTHENTICATIONFAILED") {
      throw new ImapAuthError(`IMAP sign-in failed for ${auth.username}@${auth.host}: ${message}`);
    }
    throw new ImapTransientError(`IMAP connection to ${auth.host} failed: ${message}`);
  }
}

/**
 * The add-seed gate: the IMAP analog of the Workspace getProfile probe.
 * Connects, opens INBOX read-only, disconnects. Throws ImapAuthError on bad
 * credentials, ImapTransientError on an unreachable host.
 */
export async function verifyImapLogin(auth: SeedImapAuth): Promise<void> {
  const client = await connectClient(auth);
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch (err) {
    throw new ImapTransientError(
      `Signed in, but opening INBOX failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await safeLogout(client);
  }
}

/** Look up the probe by RFC Message-ID. Accepts the id with or without <>. */
export async function findProbeViaImap(
  auth: SeedImapAuth,
  rfcMessageId: string,
): Promise<ImapProbeResult> {
  const bareId = rfcMessageId.trim().replace(/^<|>$/g, "");
  const client = await connectClient(auth);
  try {
    const isGmail = client.capabilities?.has("X-GM-EXT-1") ?? false;
    const boxes = await client.list();
    return isGmail
      ? await gmailLookup(client, boxes, bareId)
      : await genericLookup(client, boxes, bareId);
  } catch (err) {
    if (err instanceof ImapAuthError || err instanceof ImapTransientError) throw err;
    throw new ImapTransientError(
      `IMAP lookup on ${auth.host} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await safeLogout(client);
  }
}

// ── Gmail-over-IMAP (X-GM-EXT-1) ─────────────────────────────────────────

async function gmailLookup(
  client: ImapFlow,
  boxes: ListResponse[],
  bareId: string,
): Promise<ImapProbeResult> {
  // Special-use attributes are locale-proof ("[Gmail]/All Mail" is English-only).
  const allPath = pathBySpecialUse(boxes, "\\All") ?? "[Gmail]/All Mail";
  const spamPath = pathBySpecialUse(boxes, "\\Junk") ?? "[Gmail]/Spam";

  await client.mailboxOpen(allPath, { readOnly: true });
  const hit = await searchByMessageId(client, bareId, true);
  if (hit != null) {
    const msg = await fetchProbeMeta(client, hit, true);
    const labels = msg.labels;
    const inInbox = labels?.includes("\\Inbox") ?? false;
    let promotionsHit: boolean | null = null;
    if (inInbox) {
      // Second X-GM-RAW search: is the probe ALSO in category:promotions?
      // Only meaningful when the raw-search extension actually worked.
      const promo = await gmRawSearch(client, `rfc822msgid:${bareId} category:promotions`);
      promotionsHit = promo == null ? null : promo.length > 0;
    }
    return {
      found: true,
      folder: inInbox ? "inbox" : "archive",
      gmLabels: labels,
      promotionsHit,
      authResultsHeader: msg.authHeader,
    };
  }

  // Spam is excluded from All Mail: probe it explicitly.
  try {
    await client.mailboxOpen(spamPath, { readOnly: true });
  } catch {
    return notFound(); // no Spam folder visible over IMAP: nothing more to check
  }
  const spamHit = await searchByMessageId(client, bareId, false);
  if (spamHit != null) {
    const msg = await fetchProbeMeta(client, spamHit, true);
    return {
      found: true,
      folder: "junk",
      gmLabels: msg.labels,
      promotionsHit: null,
      authResultsHeader: msg.authHeader,
    };
  }
  return notFound();
}

// ── Generic IMAP (Yahoo etc.) ────────────────────────────────────────────

const JUNK_NAME_FALLBACKS = ["bulk", "bulk mail", "spam", "junk", "junk e-mail", "junk email"];

async function genericLookup(
  client: ImapFlow,
  boxes: ListResponse[],
  bareId: string,
): Promise<ImapProbeResult> {
  await client.mailboxOpen("INBOX", { readOnly: true });
  const inboxHit = await searchByMessageId(client, bareId, false);
  if (inboxHit != null) {
    const msg = await fetchProbeMeta(client, inboxHit, false);
    return { found: true, folder: "inbox", gmLabels: null, promotionsHit: null, authResultsHeader: msg.authHeader };
  }

  const junkPath =
    pathBySpecialUse(boxes, "\\Junk") ??
    boxes.find((b) => JUNK_NAME_FALLBACKS.includes(lastSegment(b.path).toLowerCase()))?.path;
  if (!junkPath) return notFound();

  await client.mailboxOpen(junkPath, { readOnly: true });
  const junkHit = await searchByMessageId(client, bareId, false);
  if (junkHit != null) {
    const msg = await fetchProbeMeta(client, junkHit, false);
    return { found: true, folder: "junk", gmLabels: null, promotionsHit: null, authResultsHeader: msg.authHeader };
  }
  return notFound();
}

// ── Shared lookup plumbing ───────────────────────────────────────────────

function notFound(): ImapProbeResult {
  return { found: false, folder: null, gmLabels: null, promotionsHit: null, authResultsHeader: null };
}

function pathBySpecialUse(boxes: ListResponse[], use: string): string | undefined {
  return boxes.find((b) => b.specialUse === use)?.path;
}

function lastSegment(path: string): string {
  const parts = path.split(/[/.]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * Find the probe's UID in the OPEN mailbox. Prefers Gmail's X-GM-RAW
 * `rfc822msgid:` (exact-id semantics) when asked; falls back to the RFC 3501
 * HEADER search, which is substring-based: the bare id matches whether the
 * stored header carries angle brackets or not. Returns null when absent.
 */
async function searchByMessageId(
  client: ImapFlow,
  bareId: string,
  preferGmRaw: boolean,
): Promise<number | null> {
  if (preferGmRaw) {
    const uids = await gmRawSearch(client, `rfc822msgid:${bareId}`);
    if (uids != null) return uids.length > 0 ? uids[uids.length - 1] : null;
  }
  const uids = ((await client.search({ header: { "message-id": bareId } }, { uid: true })) ||
    []) as number[];
  return uids.length > 0 ? uids[uids.length - 1] : null;
}

/** X-GM-RAW search; null when the server/library rejects the extension. */
async function gmRawSearch(client: ImapFlow, raw: string): Promise<number[] | null> {
  try {
    // imapflow's SearchObject key for X-GM-RAW. Cast kept narrow so a library
    // rename surfaces here (falls back to the HEADER search) instead of crashing.
    const uids = await client.search({ gmraw: raw } as Parameters<ImapFlow["search"]>[0], {
      uid: true,
    });
    return (uids || []) as number[];
  } catch {
    return null;
  }
}

/**
 * Read the probe's Authentication-Results header (+ X-GM-LABELS on Gmail).
 * Header-only fetch: PEEK semantics, nothing is marked read.
 */
async function fetchProbeMeta(
  client: ImapFlow,
  uid: number,
  withLabels: boolean,
): Promise<{ authHeader: string | null; labels: string[] | null }> {
  const msg = await client.fetchOne(
    String(uid),
    { headers: ["authentication-results"], ...(withLabels ? { labels: true } : {}) },
    { uid: true },
  );
  if (!msg) return { authHeader: null, labels: null };
  const authHeader = headerValue(msg.headers, "authentication-results");
  const labels =
    withLabels && msg.labels != null ? Array.from(msg.labels as Iterable<string>) : null;
  return { authHeader, labels };
}

/** Extract one header's value from a raw header block (unfolds continuations). */
function headerValue(headersBuf: Buffer | undefined, name: string): string | null {
  if (!headersBuf) return null;
  const unfolded = headersBuf.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    if (line.slice(0, idx).trim().toLowerCase() === name) {
      const value = line.slice(idx + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

async function safeLogout(client: ImapFlow): Promise<void> {
  try {
    await client.logout();
  } catch {
    // Connection already gone: nothing to release.
  }
}
