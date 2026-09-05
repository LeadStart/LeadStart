// Drift guard for the in-app Onboarding Preview (Admin → Workflows → Onboarding).
//
// The preview (src/components/workflows/onboarding-preview.tsx) renders the REAL
// client-facing surfaces: the proposal email, the hosted quote page, and the
// welcome page: fed by the live default config. "Live" only holds if two things
// stay true, and neither can be a runtime assertion, so this test enforces them:
//
//   1. The preview DERIVES its defaults (warm-up, quote-expiry, email subject +
//      sender) from the shared constants, by import: never a re-typed literal.
//   2. Every CONSUMER surface a customer actually hits keeps using those same
//      constants, so what ships == what the preview shows.
//
// It also asserts the preview imports the real surface code (not a copy of it).
// Run:  npx tsx scripts/test-onboarding-preview-sync.ts

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
  }
}
function extract(rel: string, re: RegExp, label: string): string | null {
  const m = read(rel).match(re);
  if (!m) {
    fail++;
    console.log(`  ✗ could not find ${label} in ${rel} (renamed? update the extractor + the preview)`);
    return null;
  }
  return m[1];
}

const SCHEDULE = "src/lib/billing/schedule.ts";
const QUOTE_EMAIL = "src/lib/email/quote-proposal.ts";
const DATA = "src/components/workflows/onboarding-preview.data.ts";
const PREVIEW = "src/components/workflows/onboarding-preview.tsx";
const QUOTES_ROUTE = "src/app/api/billing/quotes/route.ts";
const QUOTE_LAYOUT = "src/components/billing/quote-layout.tsx";
const WELCOME_PAGE = "src/app/billing/welcome/page.tsx";
const WELCOME_CONTENT = "src/components/billing/welcome-content.tsx";
const BILLING_PAGE = "src/app/(dashboard)/admin/settings/billing/page.tsx";
const WEBHOOKS = "src/lib/stripe/webhooks.ts";

const dataText = read(DATA);
const previewText = read(PREVIEW);

// ---- live default VALUES: extract from source (shown for visibility) --------
console.log("live defaults (source of truth)");
const warmingDays = extract(SCHEDULE, /DEFAULT_WARMING_DAYS\s*=\s*(\d+)/, "DEFAULT_WARMING_DAYS");
const expiryDays = extract(SCHEDULE, /DEFAULT_QUOTE_EXPIRY_DAYS\s*=\s*(\d+)/, "DEFAULT_QUOTE_EXPIRY_DAYS");
const subject = extract(QUOTE_EMAIL, /QUOTE_EMAIL_SUBJECT\s*=\s*"([^"]+)"/, "QUOTE_EMAIL_SUBJECT");
const fromAddr = extract(QUOTE_EMAIL, /QUOTE_EMAIL_FROM_FALLBACK\s*=\s*"([^"]+)"/, "QUOTE_EMAIL_FROM_FALLBACK");
if (warmingDays) ok(true, `warm-up default = ${warmingDays} days`);
if (expiryDays) ok(true, `quote-expiry default = ${expiryDays} days`);
if (subject) ok(true, `email subject = "${subject}"`);
if (fromAddr) ok(true, `email from = "${fromAddr}"`);

// ---- preview auto-sync wiring: defaults are imported, not re-typed ----------
console.log("preview derives defaults by import (data module)");
ok(/from ["']@\/lib\/billing\/schedule["']/.test(dataText), "imports from billing/schedule");
ok(/DEFAULT_WARMING_DAYS/.test(dataText), "derives warm-up default from constant");
ok(/DEFAULT_QUOTE_EXPIRY_DAYS/.test(dataText), "derives quote-expiry default from constant");
ok(/from ["']@\/lib\/email\/quote-proposal["']/.test(dataText), "imports from email/quote-proposal");
ok(/QUOTE_EMAIL_SUBJECT/.test(dataText), "derives subject from constant");
ok(/QUOTE_EMAIL_FROM_FALLBACK/.test(dataText), "derives sender from constant");

// ---- preview renders the REAL surfaces (imports, not copies) ----------------
console.log("preview renders real production surfaces");
ok(/buildQuoteProposalEmail/.test(previewText) && /from ["']@\/lib\/email\/quote-proposal["']/.test(previewText), "renders the real proposal email");
ok(/QuoteLayout/.test(previewText) && /from ["']@\/components\/billing\/quote-layout["']/.test(previewText), "renders the real <QuoteLayout>");
ok(/WelcomeContent/.test(previewText) && /from ["']@\/components\/billing\/welcome-content["']/.test(previewText), "renders the real <WelcomeContent>");

// ---- consumer surfaces still use the shared constants (no re-hard-coding) ----
console.log("customer-facing surfaces stay on the shared constants");
const quotesText = read(QUOTES_ROUTE);
ok(/body\.warming_days \?\? DEFAULT_WARMING_DAYS/.test(quotesText), "quotes API defaults warm-up to DEFAULT_WARMING_DAYS");
ok(/subject:\s*QUOTE_EMAIL_SUBJECT/.test(quotesText), "quotes API sends QUOTE_EMAIL_SUBJECT");
ok(/EMAIL_FROM \|\| QUOTE_EMAIL_FROM_FALLBACK/.test(quotesText), "quotes API falls back to QUOTE_EMAIL_FROM_FALLBACK");

ok(/warmingDays = DEFAULT_WARMING_DAYS/.test(read(QUOTE_LAYOUT)), "QuoteLayout default warm-up = DEFAULT_WARMING_DAYS");

const welcomeText = read(WELCOME_PAGE);
ok(/from ["']@\/components\/billing\/welcome-content["']/.test(welcomeText), "welcome page renders the shared <WelcomeContent>");
ok(/DEFAULT_WARMING_DAYS/.test(welcomeText), "welcome page defaults warm-up to DEFAULT_WARMING_DAYS");
ok(/warmingDays/.test(read(WELCOME_CONTENT)), "WelcomeContent takes a warmingDays prop");

ok(/DEFAULT_QUOTE_EXPIRY_DAYS \* 24 \* 60 \* 60 \* 1000/.test(read(BILLING_PAGE)), "new-quote form defaults expiry to DEFAULT_QUOTE_EXPIRY_DAYS");
ok(/Number\(md\.warming_days\) \|\| DEFAULT_WARMING_DAYS/.test(read(WEBHOOKS)), "Stripe webhook defaults warm-up to DEFAULT_WARMING_DAYS");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
