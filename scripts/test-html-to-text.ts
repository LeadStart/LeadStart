#!/usr/bin/env node
/**
 * Unit tests for htmlToPlainText, the derivation behind the text/plain
 * alternative now attached to every transactional Resend send.
 *
 * The load-bearing property is LINK SURVIVAL: a transactional email is mostly a
 * call to action, so the final assertions run the REAL production templates and
 * check the destination URL is still reachable in the plain-text rendering.
 *
 * No network, no DB. Run: npx tsx scripts/test-html-to-text.ts
 */
import { htmlToPlainText } from "../src/lib/email/html-to-text.ts";
import { buildPortalLinkEmail } from "../src/lib/email/portal-link.ts";
import { buildQuoteProposalEmail } from "../src/lib/email/quote-proposal.ts";

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
function ok(cond: boolean, msg: string) {
  eq(cond, true, msg);
}

console.log("htmlToPlainText: structure");
eq(htmlToPlainText("<p>Hello</p>"), "Hello", "strips a simple tag");
eq(htmlToPlainText("<p>One</p><p>Two</p>"), "One\n\nTwo", "paragraphs are separated by a blank line");
eq(htmlToPlainText("<div>One</div><div>Two</div>"), "One\nTwo", "layout blocks break the line without a blank line");
eq(htmlToPlainText("a<br>b"), "a\nb", "<br> becomes a newline");
eq(htmlToPlainText("<ul><li>one</li><li>two</li></ul>"), "- one\n- two", "list items become dashes");
eq(htmlToPlainText("<tr><td>A</td><td>B</td></tr>"), "A B", "table cells stay on one line");
eq(htmlToPlainText("<style>p{color:red}</style><p>Hi</p>"), "Hi", "drops a <style> block and its contents");
eq(htmlToPlainText("<script>alert(1)</script><p>Hi</p>"), "Hi", "drops a <script> block and its contents");
eq(htmlToPlainText("<head><title>T</title></head><p>Hi</p>"), "Hi", "drops <head> so the title is not duplicated");
eq(htmlToPlainText("<!-- hidden --><p>Hi</p>"), "Hi", "drops HTML comments");
eq(htmlToPlainText("<p>a</p>\n\n\n\n<p>b</p>"), "a\n\nb", "collapses runs of blank lines down to one");

console.log("\nhtmlToPlainText: entities");
eq(htmlToPlainText("<p>Tom &amp; Jerry</p>"), "Tom & Jerry", "&amp; decodes");
eq(htmlToPlainText("<p>a&nbsp;b</p>"), "a b", "&nbsp; becomes a normal space");
eq(htmlToPlainText("<p>it&#39;s</p>"), "it's", "numeric entity decodes");
eq(htmlToPlainText("<p>A &middot; B</p>"), "A · B", "named middot decodes");
eq(htmlToPlainText("<p>&amp;lt; stays escaped</p>"), "&lt; stays escaped", "ampersand decodes last, so &amp;lt; does not become <");

console.log("\nhtmlToPlainText: no em dashes reach the wire");
eq(htmlToPlainText("<p>a &mdash; b</p>"), "a - b", "&mdash; normalises to a hyphen");
eq(htmlToPlainText("<p>a — b</p>"), "a - b", "a literal em dash normalises to a hyphen");
eq(htmlToPlainText("<p>a &ndash; b</p>"), "a - b", "&ndash; normalises to a hyphen");

console.log("\nhtmlToPlainText: links survive (the whole point)");
eq(
  htmlToPlainText('<a href="https://x.com/pay">Pay now</a>'),
  "Pay now: https://x.com/pay",
  "a labelled link keeps both label and destination",
);
eq(
  htmlToPlainText('<a href="https://x.com/pay">https://x.com/pay</a>'),
  "https://x.com/pay",
  "a link whose label IS the url is not duplicated",
);
eq(
  htmlToPlainText('<a href="https://x.com/p">Go <strong>now</strong></a>'),
  "Go now: https://x.com/p",
  "nested markup inside the label is stripped, label preserved",
);
eq(
  htmlToPlainText('<a href="https://x.com/a?b=1&amp;c=2">Link</a>'),
  "Link: https://x.com/a?b=1&c=2",
  "an entity-escaped href decodes to a usable url",
);
eq(
  htmlToPlainText('<a href="mailto:a@b.com">Email us</a>'),
  "Email us: mailto:a@b.com",
  "mailto links survive",
);

console.log("\nhtmlToPlainText: real production templates");
const portalHtml = buildPortalLinkEmail({
  clientName: "Dawson & Reed",
  portalUrl: "https://billing.stripe.com/p/session/test_123",
});
const portalText = htmlToPlainText(portalHtml);
ok(portalText.includes("https://billing.stripe.com/p/session/test_123"), "portal-link: the portal URL survives into plain text");
eq(/<[a-z][^>]*>/i.test(portalText), false, "portal-link: no HTML tags remain");
eq(portalText.includes("&nbsp;"), false, "portal-link: no raw entities remain");
eq(portalText.includes("—"), false, "portal-link: no em dash reaches the recipient");
ok(portalText.length > 40, "portal-link: plain text is non-trivial, not an empty string");
ok(!/\n{3,}/.test(portalText), "portal-link: no runs of blank lines");

const quoteHtml = buildQuoteProposalEmail({
  firstName: "Jane",
  monthlyCents: 350000,
  setupCents: 100000,
  contactSourcingCents: 50000,
  contactsCount: 500,
  quoteUrl: "https://leadstart-ebon.vercel.app/app/quote/abc123",
  expiresAt: new Date("2026-10-01T00:00:00Z").toISOString(),
});
const quoteText = htmlToPlainText(quoteHtml);
ok(quoteText.includes("https://leadstart-ebon.vercel.app/app/quote/abc123"), "quote-proposal: the quote URL survives into plain text");
eq(/<[a-z][^>]*>/i.test(quoteText), false, "quote-proposal: no HTML tags remain");
eq(quoteText.includes("—"), false, "quote-proposal: no em dash reaches the recipient");
ok(quoteText.includes("Jane"), "quote-proposal: the personal greeting survives");
ok(quoteText.length > 100, "quote-proposal: plain text is non-trivial");
ok(!/\n{3,}/.test(quoteText), "quote-proposal: no runs of blank lines");

console.log("\nhtmlToPlainText: edge cases");
eq(htmlToPlainText(""), "", "empty input stays empty");
eq(htmlToPlainText("   <p>  spaced  </p>  "), "spaced", "leading/trailing whitespace is trimmed");
eq(htmlToPlainText("<p>a<a href='https://x.com'>b</a>c</p>"), "ab: https://x.comc", "single-quoted href is still parsed");

console.log(`\nhtml-to-text: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
