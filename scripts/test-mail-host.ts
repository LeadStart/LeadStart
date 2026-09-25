#!/usr/bin/env node
/**
 * Unit tests for the prospect mail-host classifier (src/lib/enrichment/mail-host.ts)
 * and the published-owner-address helpers (src/lib/enrichment/published-email.ts).
 * Pure functions only: no DNS, no network, no DB.
 * Run: npx tsx scripts/test-mail-host.ts
 */
import { classifyMxExchange, readMailHost, isWeakMailHost } from "../src/lib/enrichment/mail-host.ts";
import {
  emailMatchesOwner,
  emailOnFirmDomain,
  isPublishedEmailProvider,
  pickPublishedOwnerEmail,
  publishedEmailsOf,
} from "../src/lib/enrichment/published-email.ts";
import { POOL_TAG, POOL_RELEASED_TAG, isPooled, withPoolTag, withPoolReleased } from "../src/lib/enrichment/pool.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

console.log("classifyMxExchange");
eq(classifyMxExchange("tamakilaw-com.mail.protection.outlook.com."), "microsoft365", "Microsoft 365 tenant MX");
eq(classifyMxExchange("aspmx.l.google.com"), "google", "Google primary MX");
eq(classifyMxExchange("alt1.aspmx.l.google.com"), "google", "Google alternate MX");
eq(classifyMxExchange("smtp.google.com"), "google", "Google's newer single MX");
eq(classifyMxExchange("aspmx2.googlemail.com"), "google", "googlemail MX");
eq(classifyMxExchange("mx1-us1.ppe-hosted.com"), "gateway", "Proofpoint Essentials");
eq(classifyMxExchange("us-smtp-inbound-1.mimecast.com"), "gateway", "Mimecast");
eq(classifyMxExchange("d123.a.ess.barracudanetworks.com"), "gateway", "Barracuda");
eq(classifyMxExchange("smtp.secureserver.net"), "godaddy", "GoDaddy mail");
eq(classifyMxExchange("mail.smithlaw.com"), "other", "self-hosted");
eq(classifyMxExchange("mx.notgoogle.com"), "other", "a lookalike host isn't Google");

console.log("readMailHost / isWeakMailHost");
eq(readMailHost({ mail_host: { host: "microsoft365", mx: "x", checked_at: "t" } }), "microsoft365", "reads the stamp");
eq(readMailHost({ mail_host: { host: "bogus" } }), null, "unknown value → null");
eq(readMailHost(null), null, "no enrichment_data → null");
eq(["microsoft365", "google"].map((h) => isWeakMailHost(h as never)), [false, false], "Microsoft 365 + Google are enriched");
eq(["gateway", "godaddy", "other", "none"].every((h) => isWeakMailHost(h as never)), true, "weak hosts go to the pool");
eq(isWeakMailHost(null), false, "an unclassified host is never pooled on a guess");

console.log("weak-email-host pool tags");
eq(isPooled(["maps", POOL_TAG]), true, "pooled contact detected");
eq(isPooled(["maps"]), false, "ordinary contact");
eq(isPooled(null), false, "no tags");
eq(withPoolTag(["maps", "prospecting"]), ["maps", "prospecting", POOL_TAG], "tagging adds the pool tag");
eq(withPoolTag([POOL_TAG]), [POOL_TAG], "tagging is idempotent");
eq(withPoolReleased(["maps", POOL_TAG]), ["maps", POOL_RELEASED_TAG], "release swaps the pool tag for the released marker");
eq(isPooled(withPoolReleased(["maps", POOL_TAG])), false, "a released contact is no longer pooled");

console.log("published-email helpers");
eq(isPublishedEmailProvider("site_scrape"), true, "site scrape reads the site");
eq(isPublishedEmailProvider("pattern_mv"), false, "pattern_mv guesses");
eq(emailOnFirmDomain("joe@smithlaw.com", "https://www.smithlaw.com/contact"), true, "same domain (URL form)");
eq(emailOnFirmDomain("joe@smithlaw.net", "smithlaw.com"), false, "different domain");
eq(emailMatchesOwner("joseph@smithlaw.com", "Joseph", "Smith"), true, "first name");
eq(emailMatchesOwner("jsmith@smithlaw.com", "Joseph", "Smith"), true, "initial + last name");
eq(emailMatchesOwner("smith.j@smithlaw.com", "Joseph", "Smith"), true, "last name inside");
eq(emailMatchesOwner("info@smithlaw.com", "Joseph", "Smith"), false, "generic inbox never matches");
eq(emailMatchesOwner("maria@smithlaw.com", "Joseph", "Smith"), false, "another person");
eq(
  pickPublishedOwnerEmail(["info@smithlaw.com", "maria@smithlaw.com", "joseph.smith@smithlaw.com"], { first: "Joseph", last: "Smith", domain: "smithlaw.com" }),
  "joseph.smith@smithlaw.com",
  "picks the owner's address among the site's emails",
);
eq(
  pickPublishedOwnerEmail(["joe@gmail.com"], { first: "Joe", last: "Smith", domain: "smithlaw.com" }),
  null,
  "an owner address off the firm's domain doesn't count",
);
eq(
  publishedEmailsOf({ enrichment: { company_emails: ["info@x.com"] }, source_row: { scrapio_emails: ["Joe@X.com", "info@x.com"] } }),
  ["info@x.com", "joe@x.com"],
  "site scrape + Scrap.io crawl, lower-cased and deduped",
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
