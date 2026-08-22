// Inbox-placement testing — the I/O half. Sends probes from a sending mailbox
// to the org's seed panel, later reads each seed back via the Gmail API, and
// persists both halves to placement_tests / placement_test_results
// (migration 00068). The pure classification/roll-up logic lives in
// ./placement.ts; the health scorer consumes placementSignalFromTest().
//
// Three entry points, shared by the admin routes and the cron:
//   startPlacementTest  — POST /api/admin/mailboxes/[id]/placement and the
//                         weekly scheduler (run-placement-tests cron)
//   checkPlacementTest  — GET  /api/admin/mailboxes/[id]/placement (so the
//                         page polling drives a quick answer) and the cron's
//                         finalizer (so a closed tab still completes)
//   latestPlacementTests / latestCompletePlacementTests — list + health cron
//
// Server-only (node:crypto via mime.ts, Supabase admin client). Never import
// from a client component.

import type { createAdminClient } from "@/lib/supabase/admin";
import { GmailAuthError, type GmailClient, type GmailListEntry } from "@/lib/gmail/client";
import { loadGmailClientForOrg } from "@/lib/gmail/org";
import {
  buildRawEmail,
  generateMessageId,
  parseGmailMessage,
  isBounce,
  extractFailedRecipient,
} from "@/lib/gmail/mime";
import { renderSpintax } from "@/lib/spintax";
import { buildTokenMap, applyTokens, sampleFallback, type TokenContact } from "@/lib/native/tokens";
import {
  MAX_SEEDS_PER_TEST,
  PLACEMENT_TIMEOUT_MS,
  buildNeutralProbe,
  classifyPlacement,
  parseAuthenticationResults,
  stripMessageIdBrackets,
  summarizeAuth,
  summarizeResults,
  type ProbeCopy,
} from "./placement";
import type { PlacementSignal } from "./inbox-health";
import type {
  NativeMailbox,
  PlacementProbe,
  PlacementTest,
  PlacementTestResult,
  SeedInbox,
} from "@/types/app";

type AdminClient = ReturnType<typeof createAdminClient>;

/** A user-facing precondition failure (no seeds, test already running, …). Routes map it to 400. */
export class PlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlacementError";
  }
}

// Mirrors SAMPLE_TOKENS in src/lib/native/tokens.ts so a campaign-copy probe
// renders exactly like the builder's sample preview.
const SAMPLE_CONTACT: TokenContact = {
  first_name: "Sarah",
  last_name: "Johnson",
  company_name: "Acme Roofing",
  title: "Owner",
  intro_line: "saw the recent project you wrapped up",
  email: "sarah@acmeroofing.com",
  phone: "(555) 010-2837",
  custom_fields: null,
};

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
}

function senderNameFor(mailbox: NativeMailbox): string {
  return mailbox.display_name?.trim() || mailbox.email_address.split("@")[0];
}

// ── Start ───────────────────────────────────────────────────────────────

export interface StartPlacementTestArgs {
  admin: AdminClient;
  mailbox: NativeMailbox;
  probe: PlacementProbe;
  triggeredBy: "manual" | "scheduled";
  /** Pass a pre-built client when looping over many mailboxes (cron). */
  gmail?: GmailClient;
}

/**
 * Send a probe from `mailbox` to every active seed on a different domain and
 * record one pending result per seed. Returns the test in 'awaiting' (or
 * 'failed' if nothing could be sent). Throws PlacementError for operator-
 * fixable preconditions; lets Gmail config/auth errors propagate so the
 * caller can surface them the same way the test-send route does.
 */
export async function startPlacementTest(
  args: StartPlacementTestArgs,
): Promise<{ test: PlacementTest; results: PlacementTestResult[] }> {
  const { admin, mailbox, probe, triggeredBy } = args;
  const organizationId = mailbox.organization_id;

  // One open run per mailbox — a second run while the first is still being
  // read would double the probe volume and muddle "which probe landed where".
  const { data: open } = await admin
    .from("placement_tests")
    .select("id")
    .eq("mailbox_id", mailbox.id)
    .in("status", ["sending", "awaiting"])
    .limit(1)
    .maybeSingle();
  if (open) {
    throw new PlacementError(
      "A placement test is already running for this mailbox — wait for it to finish.",
    );
  }

  // Seeds: active, NOT on the sender's domain (same-tenant delivery is never
  // filtered, so it can only ever read "inbox"), capped.
  const { data: seedRows, error: seedError } = await admin
    .from("seed_inboxes")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (seedError) throw new Error(`seed_inboxes read failed: ${seedError.message}`);
  const senderDomain = domainOf(mailbox.email_address);
  const seeds = ((seedRows ?? []) as SeedInbox[])
    .filter(
      (s) =>
        domainOf(s.email_address) !== senderDomain &&
        s.email_address.toLowerCase() !== mailbox.email_address.toLowerCase(),
    )
    .slice(0, MAX_SEEDS_PER_TEST);
  if (seeds.length === 0) {
    throw new PlacementError(
      `No active seed inbox on a domain other than ${senderDomain}. Add one under Seed inboxes — a seed on the sending domain can't measure placement.`,
    );
  }

  const gmail = args.gmail ?? (await loadGmailClientForOrg(admin, organizationId));
  const senderName = senderNameFor(mailbox);

  let copy: ProbeCopy;
  let campaignId: string | null = null;
  if (probe === "campaign") {
    const rendered = await renderCampaignProbe(admin, mailbox, senderName);
    copy = rendered.copy;
    campaignId = rendered.campaignId;
  } else {
    // Rotate the neutral variant per run (seconds since epoch is plenty).
    copy = buildNeutralProbe({ senderName, variant: Math.floor(Date.now() / 1000) });
  }

  const { data: testRow, error: insertError } = await admin
    .from("placement_tests")
    .insert({
      organization_id: organizationId,
      mailbox_id: mailbox.id,
      probe,
      campaign_id: campaignId,
      triggered_by: triggeredBy,
      status: "sending",
      subject: copy.subject,
      seeds_total: seeds.length,
    })
    .select("*")
    .single();
  if (insertError || !testRow) {
    throw new Error(`placement_tests insert failed: ${insertError?.message ?? "no row"}`);
  }
  const test = testRow as PlacementTest;

  const results: PlacementTestResult[] = [];
  let fatal: string | null = null;
  for (const seed of seeds) {
    if (fatal) break;
    const mintedId = generateMessageId(mailbox.email_address);
    const raw = buildRawEmail({
      fromEmail: mailbox.email_address,
      fromName: mailbox.display_name,
      to: seed.email_address,
      subject: copy.subject,
      bodyText: copy.bodyText,
      messageId: mintedId,
    });
    const row: Record<string, unknown> = {
      test_id: test.id,
      seed_inbox_id: seed.id,
      seed_email: seed.email_address,
      rfc_message_id: mintedId,
      status: "pending",
    };
    try {
      const sent = await gmail.sendMessage(mailbox.email_address, raw);
      row.gmail_message_id = sent.id;
      row.gmail_thread_id = sent.threadId;
      row.sent_at = new Date().toISOString();
      // Authoritative Message-ID (Gmail normally keeps ours; same read-back
      // the send worker does for threading).
      try {
        const meta = await gmail.getMessage(mailbox.email_address, sent.id, "metadata", ["Message-ID"]);
        const hdr = meta.payload?.headers?.find((h) => h.name.toLowerCase() === "message-id");
        if (hdr?.value) row.rfc_message_id = hdr.value;
      } catch {
        /* keep the minted id */
      }
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      row.status = "send_failed";
      row.detail = message;
      if (err instanceof GmailAuthError) {
        // Delegation broke for the SENDER — bench it (same as the send worker)
        // and stop probing; every further send would fail the same way.
        fatal = err.message;
        await admin
          .from("native_mailboxes")
          .update({ status: "error", last_error: err.message, last_error_at: new Date().toISOString() })
          .eq("id", mailbox.id);
      }
    }
    const { data: inserted } = await admin
      .from("placement_test_results")
      .insert(row)
      .select("*")
      .single();
    if (inserted) results.push(inserted as PlacementTestResult);
  }

  const pending = results.filter((r) => r.status === "pending").length;
  const nowIso = new Date().toISOString();
  const update: Record<string, unknown> =
    pending > 0
      ? { status: "awaiting", sent_at: nowIso }
      : {
          status: "failed",
          error: fatal ?? "Every probe send failed — see the per-seed details.",
          completed_at: nowIso,
        };
  const { data: updated } = await admin
    .from("placement_tests")
    .update(update)
    .eq("id", test.id)
    .select("*")
    .single();
  return { test: (updated as PlacementTest | null) ?? { ...test, ...update } as PlacementTest, results };
}

/**
 * Render step 1 of the (preferably active) native campaign this mailbox is
 * pooled into, with sample merge values — the same spintax-then-tokens order
 * the send worker uses, so the probe is the copy prospects actually receive.
 */
async function renderCampaignProbe(
  admin: AdminClient,
  mailbox: NativeMailbox,
  senderName: string,
): Promise<{ copy: ProbeCopy; campaignId: string }> {
  const { data: pool } = await admin
    .from("campaign_mailboxes")
    .select("campaign_id")
    .eq("mailbox_id", mailbox.id);
  const ids = ((pool ?? []) as { campaign_id: string }[]).map((p) => p.campaign_id);
  if (ids.length === 0) {
    throw new PlacementError(
      "This mailbox isn't in any campaign's sending pool — run a neutral probe instead.",
    );
  }
  const { data: campRows } = await admin
    .from("campaigns")
    .select("id, name, status, created_at")
    .in("id", ids)
    .eq("source_channel", "native_email")
    .order("created_at", { ascending: false });
  const camps = (campRows ?? []) as { id: string; name: string; status: string }[];
  const campaign = camps.find((c) => c.status === "active") ?? camps[0];
  if (!campaign) {
    throw new PlacementError(
      "No native email campaign uses this mailbox — run a neutral probe instead.",
    );
  }
  const { data: stepRow } = await admin
    .from("campaign_steps")
    .select("subject_template, body_template")
    .eq("campaign_id", campaign.id)
    .eq("step_index", 0)
    .maybeSingle();
  const step = stepRow as { subject_template: string | null; body_template: string | null } | null;
  if (!step?.body_template?.trim()) {
    throw new PlacementError(`Campaign "${campaign.name}" has no first-step copy to probe with.`);
  }
  const map = buildTokenMap(SAMPLE_CONTACT, senderName);
  const render = (template: string, key: string) =>
    applyTokens(renderSpintax(template, key), map, sampleFallback).trim();
  const subject = render(step.subject_template ?? "", `placement:${mailbox.id}:subject`) || "(no subject)";
  const bodyText = render(step.body_template, `placement:${mailbox.id}:body`);
  return { copy: { subject, bodyText }, campaignId: campaign.id };
}

// ── Check ───────────────────────────────────────────────────────────────

export interface CheckPlacementTestArgs {
  admin: AdminClient;
  test: PlacementTest;
  gmail?: GmailClient;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Look up every still-pending seed of an 'awaiting' test. Found → classify
 * folder + receiver auth. Not found past the timeout → 'bounced' if the
 * sender holds a DSN for it, else 'missing'. When nothing is pending any
 * more, roll the counts up onto the test and mark it complete. Safe to call
 * repeatedly (page polling + cron); each call is bounded by the seed count.
 */
export async function checkPlacementTest(
  args: CheckPlacementTestArgs,
): Promise<{ test: PlacementTest; results: PlacementTestResult[]; completed: boolean }> {
  const { admin, test } = args;
  const now = args.now ?? Date.now();
  const nowIso = new Date(now).toISOString();

  const loadResults = async (): Promise<PlacementTestResult[]> => {
    const { data, error } = await admin
      .from("placement_test_results")
      .select("*")
      .eq("test_id", test.id)
      .order("seed_email", { ascending: true });
    if (error) throw new Error(`placement_test_results read failed: ${error.message}`);
    return (data ?? []) as PlacementTestResult[];
  };
  const patch = (id: string, fields: Record<string, unknown>) =>
    admin.from("placement_test_results").update(fields).eq("id", id);

  let results = await loadResults();
  if (test.status !== "awaiting") {
    return { test, results, completed: test.status === "complete" };
  }
  const pending = results.filter((r) => r.status === "pending");
  if (pending.length === 0) {
    const done = await completeTest(admin, test, results, nowIso);
    return { test: done, results, completed: true };
  }

  const gmail = args.gmail ?? (await loadGmailClientForOrg(admin, test.organization_id));
  const { data: mbRow } = await admin
    .from("native_mailboxes")
    .select("*")
    .eq("id", test.mailbox_id)
    .maybeSingle();
  const mailbox = mbRow as NativeMailbox | null;

  // The sender's bounce notices are scanned at most once per check, and only
  // once some probe has actually timed out.
  let dsns: DsnIndex | null = null;
  const timedOut = (r: PlacementTestResult) =>
    !!r.sent_at && now - Date.parse(r.sent_at) >= PLACEMENT_TIMEOUT_MS;

  for (const r of pending) {
    if (!r.rfc_message_id) {
      await patch(r.id, {
        status: "missing",
        detail: "No Message-ID was recorded for this probe, so it cannot be looked up.",
        checked_at: nowIso,
      });
      continue;
    }

    let found: GmailListEntry[];
    try {
      found = await gmail.listMessages(
        r.seed_email,
        `rfc822msgid:${stripMessageIdBrackets(r.rfc_message_id)}`,
        5,
        true,
      );
    } catch (err) {
      if (err instanceof GmailAuthError) {
        // The SEED's delegation is broken — that's our config, not the
        // sender's deliverability. Exclude the seed (never count it as
        // missing) and bench it until an owner fixes Google Admin.
        if (r.seed_inbox_id) {
          await admin
            .from("seed_inboxes")
            .update({ status: "error", last_error: err.message, last_error_at: nowIso })
            .eq("id", r.seed_inbox_id);
        }
        await patch(r.id, {
          status: "unreadable",
          detail: err.message.slice(0, 500),
          checked_at: nowIso,
        });
      } else {
        // Transient / rate-limited: leave pending for the next pass.
        console.error(
          `[placement] read of seed ${r.seed_email} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
      continue;
    }

    if (found.length > 0) {
      const msg = await gmail.getMessage(r.seed_email, found[0].id, "metadata", [
        "Authentication-Results",
        "ARC-Authentication-Results",
      ]);
      const labels = msg.labelIds ?? [];
      const headers = msg.payload?.headers ?? [];
      const authHeader =
        headers.find((h) => h.name.toLowerCase() === "authentication-results")?.value ??
        headers.find((h) => h.name.toLowerCase() === "arc-authentication-results")?.value ??
        null;
      await patch(r.id, {
        status: classifyPlacement(labels),
        labels,
        auth_results: parseAuthenticationResults(authHeader),
        found_at: nowIso,
        checked_at: nowIso,
      });
      continue;
    }

    if (timedOut(r)) {
      if (dsns === null) {
        dsns = mailbox
          ? await scanForDsns(gmail, mailbox.email_address, test.sent_at ?? test.started_at)
          : { byThread: new Map(), byRecipient: new Map() };
      }
      const reason =
        (r.gmail_thread_id ? dsns.byThread.get(r.gmail_thread_id) : undefined) ??
        dsns.byRecipient.get(r.seed_email.toLowerCase());
      if (reason) {
        await patch(r.id, { status: "bounced", detail: reason, checked_at: nowIso });
      } else {
        const mins = Math.round(PLACEMENT_TIMEOUT_MS / 60_000);
        await patch(r.id, {
          status: "missing",
          detail: `Not found in the seed (Inbox, Promotions, or Spam) within ${mins} minutes and no bounce came back — most likely rejected at the gateway, or still delayed.`,
          checked_at: nowIso,
        });
      }
      continue;
    }

    await patch(r.id, { checked_at: nowIso });
  }

  results = await loadResults();
  if (results.some((r) => r.status === "pending")) {
    return { test, results, completed: false };
  }
  const done = await completeTest(admin, test, results, nowIso);
  return { test: done, results, completed: true };
}

interface DsnIndex {
  byThread: Map<string, string>;
  byRecipient: Map<string, string>;
}

/** Index recent bounce notices in the sender's mailbox by thread and by failed recipient. */
async function scanForDsns(
  gmail: GmailClient,
  sender: string,
  sinceIso: string,
): Promise<DsnIndex> {
  const index: DsnIndex = { byThread: new Map(), byRecipient: new Map() };
  const afterSec = Math.max(0, Math.floor(Date.parse(sinceIso) / 1000) - 60);
  let listed: GmailListEntry[];
  try {
    listed = await gmail.listMessages(
      sender,
      `from:(mailer-daemon OR postmaster) after:${afterSec}`,
      20,
      true,
    );
  } catch (err) {
    console.error(`[placement] DSN scan of ${sender} failed:`, err instanceof Error ? err.message : err);
    return index;
  }
  for (const entry of listed) {
    try {
      const msg = await gmail.getMessage(sender, entry.id, "full");
      const parsed = parseGmailMessage(msg);
      if (!isBounce(parsed)) continue;
      const reason = (parsed.subject ?? "Delivery failure").slice(0, 300);
      index.byThread.set(msg.threadId, reason);
      const recipient = extractFailedRecipient(parsed);
      if (recipient) index.byRecipient.set(recipient.toLowerCase(), reason);
    } catch {
      /* skip an unreadable notice */
    }
  }
  return index;
}

async function completeTest(
  admin: AdminClient,
  test: PlacementTest,
  results: PlacementTestResult[],
  nowIso: string,
): Promise<PlacementTest> {
  const counts = summarizeResults(results);
  const auth = summarizeAuth(results);
  const update: Record<string, unknown> = {
    status: counts.total === 0 ? "failed" : "complete",
    error: counts.total === 0 ? "No seed could be sent to or read — check the seed panel." : null,
    seeds_total: counts.total,
    inbox_count: counts.inbox,
    promotions_count: counts.promotions,
    spam_count: counts.spam,
    missing_count: counts.missing,
    auth_summary: auth,
    completed_at: nowIso,
  };
  const { data } = await admin
    .from("placement_tests")
    .update(update)
    .eq("id", test.id)
    .select("*")
    .single();
  return (data as PlacementTest | null) ?? ({ ...test, ...update } as PlacementTest);
}

// ── Lookups ─────────────────────────────────────────────────────────────

/** Latest test (any status) per mailbox — for the mailboxes list. */
export async function latestPlacementTests(
  admin: AdminClient,
  mailboxIds: string[],
): Promise<Map<string, PlacementTest>> {
  const map = new Map<string, PlacementTest>();
  if (mailboxIds.length === 0) return map;
  const { data } = await admin
    .from("placement_tests")
    .select("*")
    .in("mailbox_id", mailboxIds)
    .order("started_at", { ascending: false })
    .limit(Math.max(50, mailboxIds.length * 10));
  for (const t of (data ?? []) as PlacementTest[]) {
    if (!map.has(t.mailbox_id)) map.set(t.mailbox_id, t);
  }
  return map;
}

/**
 * Latest COMPLETE test per mailbox across every org, completed on/after
 * `sinceIso` — the health cron's input. Returns { ok:false } on a read error
 * so the caller can treat the signal as unchecked rather than "no placement".
 */
export async function latestCompletePlacementTests(
  admin: AdminClient,
  sinceIso: string,
): Promise<{ ok: boolean; byMailbox: Map<string, PlacementTest> }> {
  const byMailbox = new Map<string, PlacementTest>();
  const { data, error } = await admin
    .from("placement_tests")
    .select("*")
    .eq("status", "complete")
    .gte("completed_at", sinceIso)
    .order("completed_at", { ascending: false })
    .limit(1000);
  if (error) {
    console.error("[placement] latest complete tests read failed:", error.message);
    return { ok: false, byMailbox };
  }
  for (const t of (data ?? []) as PlacementTest[]) {
    if (!byMailbox.has(t.mailbox_id)) byMailbox.set(t.mailbox_id, t);
  }
  return { ok: true, byMailbox };
}

/** Shape a completed test into the health scorer's input. */
export function placementSignalFromTest(test: PlacementTest): PlacementSignal {
  return {
    testedAt: test.completed_at ?? test.started_at,
    probe: test.probe,
    seedsTotal: test.seeds_total,
    inbox: test.inbox_count,
    promotions: test.promotions_count,
    spam: test.spam_count,
    missing: test.missing_count,
    authSummary: test.auth_summary,
  };
}
