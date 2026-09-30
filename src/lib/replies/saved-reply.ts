// A campaign's saved reply for its hot leads (campaigns.reply_template, migration
// 00134), filled in for one lead.
//
// The OWNER writes the words once per campaign. This only fills the {{tokens}}
// from the lead's contact, e.g. {{report_link}} (the prospect's TuBe report link,
// in custom_fields), plus the sending inbox's identity ({{signature}},
// {{your_name}}). It is the campaign-copy token pass (buildTokenMap/applyTokens)
// applied to a reply. Nothing is generated, and a person reads the result in the
// reply box before sending it (no AI drafting in replies: owner rule 2026-04-21).
//
// Why: a report PDF attached to a reply landed in spam (2026-09-29), so hot
// leads get a link to their report, in a reply that's ready to send.
//
// Pure: no I/O. Tested by scripts/test-saved-reply.ts.

import { applyTokens, buildTokenMap, extractCampaignTokens, type TokenContact } from "@/lib/native/tokens";

export const MAX_REPLY_TEMPLATE_CHARS = 5000;

export interface SavedReplyInbox {
  /** The inbox the lead replied to: the reply goes out from it. */
  display_name: string | null;
  email_address: string;
  signature: string | null;
}

export interface SavedReply {
  body: string;
  /** Tokens the saved reply uses that have no value for this lead. They stay
   *  visible as {{token}} in the reply box, so nobody sends a blank by accident. */
  missing: string[];
  /** Whether the saved reply signs itself ({{signature}} / {{your_name}}). */
  signed: boolean;
}

const NO_CONTACT: TokenContact = {
  first_name: null,
  last_name: null,
  company_name: null,
  title: null,
  intro_line: null,
  email: null,
  phone: null,
  custom_fields: null,
};

export function renderSavedReply(template: string, contact: TokenContact | null, inbox: SavedReplyInbox | null): SavedReply {
  const text = template.replace(/\r\n?/g, "\n");
  const senderName = inbox ? inbox.display_name?.trim() || inbox.email_address.split("@")[0] : "";
  const map = buildTokenMap(contact ?? NO_CONTACT, senderName, inbox?.signature ?? null);
  const { standard, custom } = extractCampaignTokens([text]);
  const unfilled = [...standard, ...custom].filter((t) => !t.hasFallback && !String(map[t.key] ?? "").trim());
  // A token with no value, blank included, stays visible as {{token}} where a
  // person reads the reply (the reply box won't send while one is left), rather
  // than silently printing nothing.
  const fill = { ...map };
  for (const t of unfilled) delete fill[t.key];
  return {
    body: applyTokens(text, fill).trim(),
    missing: unfilled.map((t) => t.token),
    signed: /\{\{\s*(signature|your_?name|sender_?name|my_?name)\s*(\|[^}]*)?\}\}/i.test(text),
  };
}

/** An owner-entered saved reply, ready to store: line breaks normalized, control
 *  characters removed, trimmed; blank → null. Throws when it's over the limit. */
export function cleanReplyTemplate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!s) return null;
  if (s.length > MAX_REPLY_TEMPLATE_CHARS) {
    throw new Error(`The saved reply is too long (${MAX_REPLY_TEMPLATE_CHARS} characters max).`);
  }
  return s;
}
