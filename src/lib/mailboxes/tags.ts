// Mailbox tag helpers (migration 00101). Tags are free-form operator labels on
// native_mailboxes — named pools the campaign mailbox picker can add en masse.
// Shared by the mailbox PATCH route, the bulk tag route, and the UI so every
// entry point normalizes the same way.

export const MAX_TAG_LEN = 40;
export const MAX_TAGS_PER_MAILBOX = 25;

/**
 * Clean a raw tag list into the canonical stored form: trim each, drop blanks,
 * clamp length, and dedupe case-insensitively (first-seen casing wins), capped
 * at MAX_TAGS_PER_MAILBOX. Accepts anything (route bodies are untrusted) and
 * returns a safe string[]; non-arrays / non-strings collapse to [].
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_MAILBOX) break;
  }
  return out;
}

/** Case-insensitive membership — the picker groups tags by lowercased identity. */
export function hasTag(tags: string[], tag: string): boolean {
  const key = tag.trim().toLowerCase();
  return tags.some((t) => t.toLowerCase() === key);
}

/**
 * Clean a single raw tag into stored form: trim + clamp length. Returns "" for
 * non-strings or blanks (callers reject empty). Used by the tag-registry route's
 * add/rename where the value is one tag, not a list.
 */
export function normalizeTag(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().slice(0, MAX_TAG_LEN);
}

/**
 * One row in the Settings → Tags manager: the UNION of the mailbox_tags registry
 * (migration 00108) and the distinct tags actually present on native_mailboxes.
 * `id` is the registry row id, or null when the tag only exists ad-hoc on inboxes
 * (added via the Mailboxes chip input, never adopted into the registry).
 */
export interface MailboxTagSummary {
  id: string | null;
  name: string; // canonical display casing
  mailbox_count: number; // how many inboxes currently carry it
  registered: boolean; // present in the mailbox_tags registry
}
