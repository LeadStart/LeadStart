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

// Replace {{token}} placeholders against a resolved map. A token that matches
// nothing is left in place unchanged — unless a `fallback` is supplied and
// returns a non-null stand-in (used by SAMPLE mode so the preview reads
// naturally even for custom tokens with no real value). Does NOT trim; the
// caller trims if it needs to (the sender does).
export function applyTokens(
  text: string,
  map: Record<string, string>,
  fallback?: (rawName: string) => string | null,
): string {
  return text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, rawName: string) => {
    const key = normalizeVarKey(rawName);
    if (key in map) return map[key];
    if (fallback) {
      const alt = fallback(rawName);
      if (alt != null) return alt;
    }
    return whole; // unknown token: leave untouched
  });
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
