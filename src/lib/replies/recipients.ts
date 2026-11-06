// Who a reply from LeadStart goes to, and under what subject.
//
// By default a reply goes To the lead, Bcc the client's own copy (their
// notification inbox + the teammates they added, so the lead never sees a
// third-party address), under "Re: <original subject>". Since 2026-11-06 an
// owner or VA replying for a client from the admin Inbox can change all of it,
// the client's copy included (owner picks: removable, admin Inbox only). The
// send route resolves what the composer sent here, records the real lists on
// the reply (sent_to / sent_cc / sent_bcc, migration 00141), and the Inbox and
// portal read them back to say who got it.
//
// Pure: no DB, no network. Test: scripts/test-reply-recipients.ts.

export interface ReplyRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface ClientCopySettings {
  notification_email: string | null;
  notification_cc_emails: string[] | null;
}

/** Most addresses one reply may go to, To + Cc + Bcc together. */
export const MAX_REPLY_RECIPIENTS = 20;
/** Most addresses in one of To, Cc or Bcc (the composer's per-field limit). */
export const MAX_REPLY_FIELD_ADDRESSES = 10;
export const MAX_REPLY_SUBJECT_LENGTH = 250;

// A bare address: no display name, no spaces, commas, angle brackets or
// control characters (anything that could split or inject a header).
const ADDRESS =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** An address as stored and sent (trimmed, lowercased), or null when it isn't one. */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim().toLowerCase();
  if (a.length === 0 || a.length > 254) return null;
  return ADDRESS.test(a) ? a : null;
}

/** The client's own copy: notification inbox first, then teammates, lowercased and deduped. */
export function clientCopyAddresses(client: ClientCopySettings | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of [client?.notification_email, ...(client?.notification_cc_emails ?? [])]) {
    const a = raw?.trim().toLowerCase();
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** "Re: <original>", as the reply threads by default. */
export function defaultReplySubject(original: string | null | undefined): string {
  const base = (original ?? "").trim();
  if (!base) return "Re: (no subject)";
  return base.toLowerCase().startsWith("re:") ? base : `Re: ${base}`;
}

/** To the lead, Bcc the client's copy (never the lead twice). */
export function defaultReplyRecipients(
  leadAddress: string | null | undefined,
  client: ClientCopySettings | null | undefined,
): ReplyRecipients {
  const lead = leadAddress?.trim() ?? "";
  const leadKey = lead.toLowerCase();
  return {
    to: lead ? [lead] : [],
    cc: [],
    bcc: clientCopyAddresses(client).filter((a) => a !== leadKey),
  };
}

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The recipients a send asked for. A field left out keeps its default; a field
 * sent must be a list of addresses. An address in more than one field goes
 * only in the first (To, then Cc, then Bcc). To needs at least one address.
 */
export function resolveReplyRecipients(
  input: { to?: unknown; cc?: unknown; bcc?: unknown },
  defaults: ReplyRecipients,
): Resolved<ReplyRecipients> {
  const seen = new Set<string>();
  const out: ReplyRecipients = { to: [], cc: [], bcc: [] };
  for (const field of ["to", "cc", "bcc"] as const) {
    const given = input[field];
    if (given !== undefined && !Array.isArray(given)) {
      return { ok: false, error: `${label(field)} must be a list of addresses.` };
    }
    const list = given === undefined ? defaults[field] : (given as unknown[]);
    if (list.length > MAX_REPLY_FIELD_ADDRESSES) {
      return { ok: false, error: `${label(field)} can hold at most ${MAX_REPLY_FIELD_ADDRESSES} addresses.` };
    }
    for (const raw of list) {
      const a = normalizeAddress(raw);
      if (!a) {
        const shown = typeof raw === "string" && raw.trim() ? `"${raw.trim().slice(0, 80)}"` : "An entry";
        return { ok: false, error: `${shown} in ${label(field)} isn't an email address.` };
      }
      if (seen.has(a)) continue;
      seen.add(a);
      out[field].push(a);
    }
  }
  if (out.to.length === 0) return { ok: false, error: "Add at least one address on To." };
  if (seen.size > MAX_REPLY_RECIPIENTS) {
    return { ok: false, error: `A reply can go to at most ${MAX_REPLY_RECIPIENTS} addresses.` };
  }
  return { ok: true, value: out };
}

/** The subject a send asked for: blank keeps the default; line breaks become spaces. */
export function resolveReplySubject(input: unknown, fallback: string): Resolved<string> {
  if (input === undefined || input === null) return { ok: true, value: fallback };
  if (typeof input !== "string") return { ok: false, error: "Subject must be text." };
  const s = input.replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { ok: true, value: fallback };
  if (s.length > MAX_REPLY_SUBJECT_LENGTH) {
    return { ok: false, error: `Subject is too long (${MAX_REPLY_SUBJECT_LENGTH} characters max).` };
  }
  return { ok: true, value: s };
}

/** Same addresses in the same order. */
export function sameAddresses(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i].toLowerCase());
}

/**
 * How the client got their own copy of a sent reply, from the recorded lists:
 * "bcc" (hidden from the lead, the default), "visible" (on To or Cc), "none"
 * (taken off), or null when the reply was sent before they were recorded.
 */
export function clientCopyWent(
  reply: { sent_to?: string[] | null; sent_cc?: string[] | null; sent_bcc?: string[] | null },
  client: ClientCopySettings | null | undefined,
): "bcc" | "visible" | "none" | null {
  if (!reply.sent_to && !reply.sent_cc && !reply.sent_bcc) return null;
  const mine = new Set(clientCopyAddresses(client));
  const has = (list: string[] | null | undefined) => (list ?? []).some((a) => mine.has(a.toLowerCase()));
  if (has(reply.sent_to) || has(reply.sent_cc)) return "visible";
  return has(reply.sent_bcc) ? "bcc" : "none";
}

function label(field: "to" | "cc" | "bcc"): string {
  return field === "to" ? "To" : field === "cc" ? "Cc" : "Bcc";
}
