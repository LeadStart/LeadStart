// Onboarding Preview — DATA (single source for the inputs the preview feeds
// into the REAL client-facing surfaces).
//
// SYNC CONTRACT (mirrors enrichment-flow-map.data.ts):
//   • The DEFAULTS a customer actually gets — warm-up window, quote-expiry,
//     email subject + sender — are DERIVED from the live constants below
//     (schedule.ts, quote-proposal.ts). Change one there and this preview
//     follows automatically; rename one and the build breaks.
//   • The SAMPLE identity + pricing are illustrative — there is no single
//     org-wide price, so a believable mid-market deal is declared here (clearly
//     separated below) purely so every line of every surface has real content.
//   • scripts/test-onboarding-preview-sync.ts extracts the live values from
//     source and FAILS if the preview — or any consumer surface — drifts. Run
//     it whenever a default, the sender, or a rendered surface changes.

import {
  DEFAULT_WARMING_DAYS,
  DEFAULT_QUOTE_EXPIRY_DAYS,
} from "@/lib/billing/schedule";
import {
  QUOTE_EMAIL_SUBJECT,
  QUOTE_EMAIL_FROM_FALLBACK,
} from "@/lib/email/quote-proposal";

// ---- live org config (auto-synced to the real surfaces) --------------------
/** Default warm-up window shown on the quote + welcome surfaces. */
export const PREVIEW_WARMING_DAYS = DEFAULT_WARMING_DAYS;
/** Days a freshly-drafted quote stays valid (drives the "valid through" date). */
export const PREVIEW_QUOTE_EXPIRY_DAYS = DEFAULT_QUOTE_EXPIRY_DAYS;
/** Subject line of the proposal email. */
export const PREVIEW_EMAIL_SUBJECT = QUOTE_EMAIL_SUBJECT;
/**
 * The "From" clients see. The preview runs client-side and can't read the
 * server's EMAIL_FROM, so it shows the shared fallback — the same string the
 * send path falls back to when EMAIL_FROM is unset.
 */
export const PREVIEW_EMAIL_FROM = QUOTE_EMAIL_FROM_FALLBACK;

// ---- representative sample (illustrative — NOT org config) ------------------
// A believable mid-market home-services deal, sized so every surface has real
// content: pricing lines, a contact-sourcing line, a multi-item scope.
export const SAMPLE_CONTACT_NAME = "Summit Home Services";
export const SAMPLE_CONTACT_EMAIL = "ops@summithomeservices.com";
// The contact PERSON (distinct from the company name above) — quotes and
// notifications greet them by first name.
export const SAMPLE_CONTACT_FIRST_NAME = "Jordan";
export const SAMPLE_CONTACT_LAST_NAME = "Rivera";

export const SAMPLE_MONTHLY_CENTS = 150_000; // $1,500 / mo lead management
export const SAMPLE_SETUP_CENTS = 50_000; // $500 one-time setup
export const SAMPLE_CONTACT_SOURCING_CENTS = 75_000; // $750 one-time sourcing
export const SAMPLE_CONTACTS_COUNT = 1_000; // verified contacts sourced

export const SAMPLE_SCOPE = [
  "Dedicated sending domains + inboxes, provisioned and warmed",
  "Ongoing prospecting + verified contact sourcing",
  "Multi-step outbound sequences, written and managed for you",
  "Reply routing + hot-lead alerts sent straight to your inbox",
  "Weekly performance reporting",
].join("\n");

// Mirrors the DEFAULT_TERMS the admin new-quote form pre-fills onto every quote.
export const SAMPLE_TERMS =
  "Auto-charged monthly via Stripe once the warm-up period ends. Cancel anytime with 30 days' notice.";

// A realistic-looking (non-functional) signed quote URL for the email's CTA.
export const SAMPLE_QUOTE_URL =
  "https://leadstart-ebon.vercel.app/app/quote/preview?t=sample";
