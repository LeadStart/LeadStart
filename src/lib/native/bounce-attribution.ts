// Which native send a bounce notice reports on. Shared by the reply poller
// (/api/cron/poll-native-replies) and the one-off history backfill
// (scripts/backfill-native-bounces.ts) so both attribute a notice identically.
//
// Most exact first:
//   1. the original Message-ID the notice carries (X-Original-Message-ID, the
//      returned headers, In-Reply-To, References; ranked by parseGmailMessage):
//      names the exact send, so a step-3 failure marks step 3 even when the
//      notice landed on a thread of its own (Gmail threads a notice with our
//      mail only when the subjects match; Microsoft 365 reports never do);
//   2. the thread (its latest send);
//   3. the failed recipient's latest send from this mailbox BEFORE the notice
//      arrived, so a later follow-up is never blamed for an earlier failure.
// Microsoft 365 / Mimecast reports carry no original message at all, so for
// them (3) is the only route, via the Original-/Final-Recipient DSN fields.
//
// Selects no migration-00131 column, so it keeps working if the code deploys
// before that migration is applied.

import type { createAdminClient } from "@/lib/supabase/admin";
import { extractFailedRecipient, type BounceVerdict, type ParsedGmailMessage } from "../gmail/mime";
import { escapeLikePattern } from "../utils";

type AdminClient = ReturnType<typeof createAdminClient>;

export interface BouncedSendRow {
  id: string;
  organization_id: string;
  campaign_id: string;
  contact_id: string;
  enrollment_id: string | null;
  to_email: string;
  status: string;
  step_index?: number;
  sent_at?: string;
  soft_bounced_at?: string | null;
}

const COLS =
  "id, organization_id, campaign_id, contact_id, enrollment_id, to_email, status, rfc_message_id, step_index, sent_at, soft_bounced_at";

export async function findBouncedSend(
  admin: AdminClient,
  mailboxId: string,
  parsed: ParsedGmailMessage,
  threadSend: BouncedSendRow | null,
): Promise<{ send: BouncedSendRow | null; via: "message_id" | "thread" | "recipient" | null }> {
  const ids = parsed.dsn.originalMessageIds.slice(0, 50);
  if (ids.length > 0) {
    const { data } = await admin
      .from("native_sends")
      .select(COLS)
      .eq("mailbox_id", mailboxId)
      .in("rfc_message_id", ids);
    const rows = (data ?? []) as (BouncedSendRow & { rfc_message_id: string })[];
    if (rows.length > 0) {
      // The ids are ordered most-exact first, so the earliest-listed match wins.
      rows.sort((a, b) => ids.indexOf(a.rfc_message_id) - ids.indexOf(b.rfc_message_id));
      return { send: rows[0], via: "message_id" };
    }
  }
  if (threadSend) return { send: threadSend, via: "thread" };
  const recipient = extractFailedRecipient(parsed);
  if (!recipient) return { send: null, via: null };
  let query = admin
    .from("native_sends")
    .select(COLS)
    .eq("mailbox_id", mailboxId)
    .ilike("to_email", escapeLikePattern(recipient));
  if (parsed.internalDateMs) query = query.lte("sent_at", new Date(parsed.internalDateMs).toISOString());
  const { data } = await query.order("sent_at", { ascending: false }).limit(1).maybeSingle();
  const send = (data as BouncedSendRow | null) ?? null;
  return { send, via: send ? "recipient" : null };
}

/** bounce_reason text: the server's own words beat the notice's generic subject. */
export function bounceReasonText(v: BounceVerdict, subject: string | null): string {
  const text = v.diagnostic ?? subject ?? "Delivery failure";
  return (v.code && !text.includes(v.code) ? `${v.code} ${text}` : text).slice(0, 300);
}
