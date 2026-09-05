#!/usr/bin/env node
/**
 * Guards the transactional-email typography contract (src/lib/email/brand.ts).
 *
 * The subtle part is the Outlook guard: Outlook on Windows uses the Word
 * engine, which falls back to Times New Roman when it meets a font family it
 * does not recognise, ignoring the rest of the stack. So the webfont <link>
 * must be HIDDEN from Outlook and Outlook must be pinned to Arial separately.
 * Delete either half and Outlook silently renders every invoice in a serif.
 *
 * No network, no DB. Run: npx tsx scripts/test-email-brand.ts
 */
import { EMAIL_FONT_STACK, EMAIL_FONT_HEAD } from "../src/lib/email/brand.ts";
import { htmlToPlainText } from "../src/lib/email/html-to-text.ts";
import { buildQuoteProposalEmail } from "../src/lib/email/quote-proposal.ts";
import { buildPortalLinkEmail } from "../src/lib/email/portal-link.ts";
import { buildInvoiceEmail } from "../src/lib/email/invoice.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (got === want) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
  }
}
const ok = (c: boolean, m: string) => eq(c, true, m);

console.log("EMAIL_FONT_STACK");
ok(EMAIL_FONT_STACK.startsWith("'Poppins'"), "Poppins is the FIRST family, so Apple Mail renders the brand face");
ok(EMAIL_FONT_STACK.includes("Arial"), "Arial is in the stack for clients that strip webfonts");
ok(EMAIL_FONT_STACK.trimEnd().endsWith("sans-serif"), "the stack ends in a generic sans-serif");
eq(EMAIL_FONT_STACK.includes("Inter"), false, "Inter is gone: it was never loaded and is not the brand font");

console.log("\nEMAIL_FONT_HEAD: the Outlook guard");
ok(EMAIL_FONT_HEAD.includes("<!--[if !mso]><!-->"), "opens a downlevel-revealed conditional");
ok(EMAIL_FONT_HEAD.includes("<!--<![endif]-->"), "closes the downlevel-revealed conditional");
ok(EMAIL_FONT_HEAD.includes("<!--[if mso]>"), "has an mso-only block");
ok(EMAIL_FONT_HEAD.includes("<![endif]-->"), "closes the mso-only block");
ok(
  EMAIL_FONT_HEAD.indexOf("fonts.googleapis.com") > EMAIL_FONT_HEAD.indexOf("<!--[if !mso]><!-->") &&
    EMAIL_FONT_HEAD.indexOf("fonts.googleapis.com") < EMAIL_FONT_HEAD.indexOf("<!--<![endif]-->"),
  "the webfont link sits INSIDE the not-mso conditional, so Outlook never sees it",
);
const msoBlock = EMAIL_FONT_HEAD.slice(EMAIL_FONT_HEAD.indexOf("<!--[if mso]>"));
ok(msoBlock.includes("Arial"), "the mso block pins Outlook to Arial");
ok(msoBlock.includes("!important"), "the mso block uses !important so it beats inline styles");
eq(msoBlock.includes("Poppins"), false, "the mso block never names Poppins (that is what triggers Times New Roman)");
const nonMso = EMAIL_FONT_HEAD.slice(0, EMAIL_FONT_HEAD.indexOf("<!--[if mso]>"));
eq(nonMso.includes("!important"), false, "the non-mso block omits !important, so inline font-family still wins");

console.log("\nRendered templates");
const samples: [string, string][] = [
  ["quote-proposal", buildQuoteProposalEmail({
    firstName: "Jane", monthlyCents: 350000, setupCents: 100000,
    contactSourcingCents: 50000, contactsCount: 500,
    quoteUrl: "https://example.com/q/1",
    expiresAt: new Date("2026-10-01T00:00:00Z").toISOString(),
  })],
  ["portal-link", buildPortalLinkEmail({ clientName: "Dawson & Reed", portalUrl: "https://example.com/p/1" })],
  ["invoice", buildInvoiceEmail({
    clientName: "Dawson & Reed", invoiceNumber: "INV-1", amountDueCents: 350000,
    currency: "usd", issuedAt: new Date("2026-09-01T00:00:00Z").toISOString(),
    dueAt: new Date("2026-09-15T00:00:00Z").toISOString(),
    periodStart: new Date("2026-09-01T00:00:00Z").toISOString(),
    periodEnd: new Date("2026-09-30T00:00:00Z").toISOString(),
    lineItems: [{ description: "Lead management", periodLabel: "Sep 2026", amountCents: 350000 }],
    subtotalCents: 350000, taxCents: 0, totalCents: 350000,
    hostedInvoiceUrl: "https://example.com/i/1", invoicePdfUrl: null,
  })],
];

for (const [name, html] of samples) {
  ok(html.includes("Poppins"), `${name}: names Poppins`);
  eq(html.includes("'Inter'"), false, `${name}: no longer declares Inter`);
  ok(html.includes("<!--[if mso]>"), `${name}: carries the Outlook guard`);
  ok(html.includes("fonts.googleapis.com/css2?family=Poppins"), `${name}: loads the Poppins webfont`);
  ok(
    html.indexOf("${EMAIL_FONT") === -1 && html.indexOf("${STACK") === -1,
    `${name}: no unsubstituted template placeholder leaked`,
  );
  // The new <style> blocks live in <head>; none of that CSS may reach the
  // plain-text alternative that now rides along with every send.
  const text = htmlToPlainText(html);
  eq(text.includes("font-family"), false, `${name}: no CSS leaks into the plain-text part`);
  eq(text.includes("mso"), false, `${name}: no Outlook conditional leaks into the plain-text part`);
  eq(text.includes("fonts.googleapis"), false, `${name}: no font URL leaks into the plain-text part`);
  ok(text.length > 60, `${name}: plain-text part is still substantive`);
}

console.log(`\nemail-brand: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
