/**
 * Shared, CLIENT-SAFE token helpers for native email {{merge_tag}} substitution.
 *
 * This module is the single source of truth for how the native sender resolves
 * {{tokens}} — it is imported by BOTH the real sender (server, in
 * src/app/api/cron/run-native-sequences/route.ts) and the builder preview
 * (client component). Keep it free of `node:` imports and npm deps so it bundles
 * into the browser.
 *
 * The rules mirror the sender exactly:
 *   - Variable names are folded via normalizeVarKey (lowercase, alnum-only) so
 *     "Property Address", "property_address" and "PropertyAddress" all match.
 *   - buildTokenMap produces the same standard map the sender builds, plus every
 *     custom_fields entry keyed by its normalized name.
 *   - applyTokens leaves an unknown {{token}} untouched (unless a fallback is
 *     supplied) — a typo'd placeholder shows up in a preview instead of silently
 *     blanking a line of copy.
 *
 * Spintax is resolved SEPARATELY, before tokens, by the caller (see the sender's
 * renderTemplate). This module only concerns itself with {{token}} substitution.
 */

// Fold a variable name to a comparison key: lowercase, drop everything that
// isn't a letter or digit. Kept byte-identical to the sender's normalizeVarKey.
export function normalizeVarKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// The subset of contact columns the token map reads from. A structural type so
// the caller can pass a real Contact row (server) or a trimmed client-side
// shape without importing the full Contact type.
export interface TokenContact {
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  title: string | null;
  intro_line: string | null;
  email: string | null;
  phone: string | null;
  custom_fields: Record<string, unknown> | null;
}

// Build the resolved token map for a contact + sending identity. Standard keys
// are already in normalizeVarKey() form; custom_fields entries are folded the
// same way. null custom values are skipped; non-strings are String()-coerced.
export function buildTokenMap(
  contact: TokenContact,
  senderName: string,
): Record<string, string> {
  const map: Record<string, string> = {
    firstname: contact.first_name ?? "",
    lastname: contact.last_name ?? "",
    fullname: [contact.first_name, contact.last_name].filter(Boolean).join(" "),
    company: contact.company_name ?? "",
    companyname: contact.company_name ?? "",
    title: contact.title ?? "",
    introline: contact.intro_line ?? "",
    intro: contact.intro_line ?? "",
    email: contact.email ?? "",
    phone: contact.phone ?? "",
    yourname: senderName,
    sendername: senderName,
    myname: senderName,
  };

  const cf = contact.custom_fields;
  if (cf && typeof cf === "object") {
    for (const [k, v] of Object.entries(cf)) {
      if (v == null) continue;
      map[normalizeVarKey(k)] = typeof v === "string" ? v : String(v);
    }
  }

  return map;
}

// Split a raw {{token}} body into its variable name and optional inline
// fallback, on the FIRST "|":  "{{first_name | there}}" -> { name: "first_name",
// fallback: "there" }; "{{first_name}}" -> { name: "first_name", fallback: null }.
// Both sides are trimmed. Spintax is always resolved BEFORE tokens (see the
// sender's renderTemplate), so a "|" inside {{ }} is never a spintax pipe — it is
// always an author-written default.
export function splitToken(raw: string): { name: string; fallback: string | null } {
  const i = raw.indexOf("|");
  if (i < 0) return { name: raw.trim(), fallback: null };
  return { name: raw.slice(0, i).trim(), fallback: raw.slice(i + 1).trim() };
}

// Replace {{token}} placeholders against a resolved map, with support for an
// inline default: {{token|fallback}}.
//
// Resolution order for each placeholder:
//   1. A non-empty resolved value from the map wins.
//   2. Else an inline `|fallback` (even an explicit empty one, {{token|}}, which
//      means "blank it") fills the spot.
//   3. Else a present-but-empty map value blanks it — identical to the prior
//      behavior, where a standard token for a missing contact field resolved to
//      "" rather than leaking.
//   4. Else the caller's `fallback` fn decides. The live sender passes
//      () => "" so a send NEVER emits a raw {{token}}; the builder preview passes
//      sampleFallback (humanize) or nothing (leave the {{token}} visible so an
//      author still spots a typo).
//
// Own-property lookup (Object.hasOwn) so a token normalizing to an
// Object.prototype member ("constructor", "valueof") can't resolve to a
// prototype function. Does NOT trim; the caller trims if it needs to.
export function applyTokens(
  text: string,
  map: Record<string, string>,
  fallback?: (rawName: string) => string | null,
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, rawName: string) => {
    const { name, fallback: inlineFallback } = splitToken(rawName);
    const key = normalizeVarKey(name);
    const val = Object.hasOwn(map, key) ? map[key] : undefined;
    if (val) return val; // 1. non-empty resolved value
    if (inlineFallback !== null) return inlineFallback; // 2. authored |default
    if (val !== undefined) return val; // 3. present-but-empty → blank
    if (fallback) {
      const alt = fallback(name); // 4. caller's fallback (sender: "", preview: sample)
      if (alt != null) return alt;
    }
    return whole; // truly unresolved, no fallback: leave untouched
  });
}

// Sender-identity tokens: resolved from the sending mailbox, never from the
// contact, so they are excluded when computing which fields a CSV must supply.
// Keys in normalizeVarKey() form; must stay in sync with buildTokenMap above.
export const SENDER_TOKEN_KEYS: ReadonlySet<string> = new Set([
  "yourname",
  "sendername",
  "myname",
]);

// Which contact columns satisfy each standard token (normalizeVarKey form).
// Mirrors the keys buildTokenMap derives from contact columns — if a token
// key is listed here, mapping a CSV column to the named field(s) fills it.
export const STANDARD_TOKEN_FIELDS: Record<string, string[]> = {
  firstname: ["first_name"],
  lastname: ["last_name"],
  fullname: ["first_name", "last_name"],
  company: ["company_name"],
  companyname: ["company_name"],
  title: ["title"],
  introline: ["intro_line"],
  intro: ["intro_line"],
  email: ["email"],
  phone: ["phone"],
};

export interface CampaignTokenInfo {
  /**
   * Tokens satisfied by standard contact columns. token = first raw spelling
   * seen (the variable name only, without any inline |fallback).
   */
  standard: { token: string; key: string; fields: string[]; hasFallback: boolean }[];
  /** Tokens that must come from contacts.custom_fields. */
  custom: { token: string; key: string; hasFallback: boolean }[];
}

// Extract the distinct {{token}} set a campaign's templates actually use,
// classified standard vs custom, sender tokens excluded. The scan pattern is
// byte-identical to applyTokens' so extraction and send-time substitution can
// never disagree about what counts as a token. Deduped by normalized key in
// first-appearance order; single-brace spintax {a|b} never matches.
//
// An inline default ({{token|there}}) is stripped before the name/key are
// computed, so a fallback'd token is counted under its real variable name (not
// "token|there"). `hasFallback` is true only when EVERY occurrence of the token
// carries an inline default — i.e. the token can never render blank — so the
// import/preview "this will be blank" warnings can suppress fully-defaulted vars.
export function extractCampaignTokens(
  templates: (string | null | undefined)[],
): CampaignTokenInfo {
  type Acc =
    | { kind: "standard"; token: string; key: string; fields: string[]; hasFallback: boolean }
    | { kind: "custom"; token: string; key: string; hasFallback: boolean };
  const seen = new Map<string, Acc>();

  for (const text of templates) {
    if (!text) continue;
    for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      const { name, fallback } = splitToken(m[1]);
      const key = normalizeVarKey(name);
      if (!key || SENDER_TOKEN_KEYS.has(key)) continue;
      const has = fallback !== null;
      const existing = seen.get(key);
      if (existing) {
        // "Protected" only if ALL uses default — one bare {{x}} can still blank.
        existing.hasFallback = existing.hasFallback && has;
        continue;
      }
      // Object.hasOwn, not `key in`, so a token normalizing to an
      // Object.prototype member ("constructor", "tostring", "valueof")
      // isn't miscounted as a standard field.
      if (Object.hasOwn(STANDARD_TOKEN_FIELDS, key)) {
        seen.set(key, {
          kind: "standard",
          token: name,
          key,
          fields: STANDARD_TOKEN_FIELDS[key],
          hasFallback: has,
        });
      } else {
        seen.set(key, { kind: "custom", token: name, key, hasFallback: has });
      }
    }
  }

  // Map preserves insertion (= first-appearance) order; split into the two
  // classes keeping that relative order within each.
  const standard: CampaignTokenInfo["standard"] = [];
  const custom: CampaignTokenInfo["custom"] = [];
  for (const v of seen.values()) {
    if (v.kind === "standard") {
      standard.push({ token: v.token, key: v.key, fields: v.fields, hasFallback: v.hasFallback });
    } else {
      custom.push({ token: v.token, key: v.key, hasFallback: v.hasFallback });
    }
  }
  return { standard, custom };
}

// Realistic sample values for the STANDARD keys, used when a campaign has no
// real contact to preview against (brand-new campaign, client with no contacts).
// Keys are in normalizeVarKey() form.
export const SAMPLE_TOKENS: Record<string, string> = {
  firstname: "Sarah",
  lastname: "Johnson",
  fullname: "Sarah Johnson",
  company: "Acme Roofing",
  companyname: "Acme Roofing",
  title: "Owner",
  introline: "saw the recent project you wrapped up",
  intro: "saw the recent project you wrapped up",
  email: "sarah@acmeroofing.com",
  phone: "(555) 010-2837",
  yourname: "Alex Rivera",
  sendername: "Alex Rivera",
  myname: "Alex Rivera",
};

// A few common custom tokens get hand-picked sample values so the preview reads
// naturally (normalizeVarKey form). Anything not listed here is humanized below.
const SAMPLE_CUSTOM: Record<string, string> = {
  propertyaddress: "123 Oak Street",
  address: "123 Oak Street",
  solddate: "March 3rd",
  date: "March 3rd",
  city: "Austin",
};

// Turn a raw token name into a readable stand-in: split camelCase, replace
// separators with spaces, collapse whitespace, and Title Case each word. So
// "listingAgent" -> "Listing Agent", "policy_number" -> "Policy Number".
function humanizeToken(rawName: string): string {
  const spaced = rawName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return rawName;
  return spaced
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Fallback for unknown/custom tokens in SAMPLE mode: a curated value if we have
// one, otherwise a humanized version of the token name so the preview still
// reads as prose rather than showing a raw {{placeholder}}.
export function sampleFallback(rawName: string): string {
  const key = normalizeVarKey(rawName);
  if (key in SAMPLE_CUSTOM) return SAMPLE_CUSTOM[key];
  return humanizeToken(rawName);
}

// ── Campaign variable registry ──────────────────────────────────────────────
//
// The persisted per-campaign variable SCHEMA (campaigns.variables JSONB,
// migration 00092): the single source of truth for which merge variables a
// campaign expects while building or in flight. It is the schema;
// contacts.custom_fields holds the per-contact VALUES; campaign_enrollments is
// WHO receives. Copy edits and CSV/CRM ingests both reconcile INTO this registry
// rather than each being an independent truth.
export interface CampaignVariable {
  /** Canonical raw spelling (variable name only, no |fallback). */
  token: string;
  /** normalizeVarKey(token) — the identity used for de-duping + resolution. */
  key: string;
  kind: "standard" | "custom";
  /** For standard vars: which contact columns satisfy the token. */
  fields?: string[];
}

// Reconcile a campaign's stored variable registry with the current copy tokens
// and any custom columns mapped on a list ingest. Returns the ordered, de-duped
// (by key) UNION: existing registry first (preserving order, canonical spelling,
// and kind), then copy standard tokens, then copy custom tokens, then mapped
// custom columns that aren't referenced in the copy yet (the list drives them,
// Instantly-style). Pure — callers persist the result.
export function reconcileCampaignVariables(
  existing: CampaignVariable[] | null | undefined,
  copyTokens: CampaignTokenInfo,
  mappedCustom?: { token: string; key: string }[] | null,
): CampaignVariable[] {
  const byKey = new Map<string, CampaignVariable>();
  const add = (v: CampaignVariable) => {
    if (!v.key || byKey.has(v.key)) return;
    byKey.set(v.key, v);
  };

  if (Array.isArray(existing)) {
    for (const v of existing) {
      if (!v || typeof v.key !== "string" || typeof v.token !== "string") continue;
      if (v.kind !== "standard" && v.kind !== "custom") continue;
      add({
        token: v.token,
        key: v.key,
        kind: v.kind,
        ...(Array.isArray(v.fields) ? { fields: v.fields } : {}),
      });
    }
  }
  for (const t of copyTokens.standard) {
    add({ token: t.token, key: t.key, kind: "standard", fields: t.fields });
  }
  for (const t of copyTokens.custom) {
    add({ token: t.token, key: t.key, kind: "custom" });
  }
  for (const t of mappedCustom ?? []) {
    if (t && typeof t.key === "string" && typeof t.token === "string") {
      add({ token: t.token, key: t.key, kind: "custom" });
    }
  }

  return [...byKey.values()];
}
