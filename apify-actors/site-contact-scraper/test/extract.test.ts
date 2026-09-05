#!/usr/bin/env node
// Unit tests for extract.ts: pure, no network. Run: npx tsx test/extract.test.ts
import { extractContacts } from "../src/extract.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
}
function eq(a: unknown, b: unknown, msg: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg}, got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
}

const html = `
<html><body>
  <a href="mailto:jane.doe@acme.com">Email Jane</a>
  <a href="mailto:info@acme.com">General</a>
  <a href="tel:+1 (555) 123-4567">Call us</a>
  <p>Reach sales@acme.com or visit <img src="logo@2x.png"></p>
  <a href="https://www.linkedin.com/company/acme-inc">LinkedIn</a>
  <a href="https://twitter.com/acmeinc">Twitter</a>
</body></html>`;

const r = extractContacts(html, { firstName: "Jane", lastName: "Doe" });

// Emails: jane.doe, info, sales collected; logo@2x.png rejected.
ok(r.emails.includes("jane.doe@acme.com"), "collects jane.doe@acme.com");
ok(r.emails.includes("info@acme.com"), "collects info@acme.com");
ok(r.emails.includes("sales@acme.com"), "collects sales@acme.com from text");
ok(!r.emails.some((e) => e.includes("logo")), "rejects logo@2x.png asset");

// Role split.
ok(r.companyEmails.includes("info@acme.com"), "info@ is a company email");
ok(r.companyEmails.includes("sales@acme.com"), "sales@ is a company email");
ok(!r.companyEmails.includes("jane.doe@acme.com"), "jane.doe is NOT a company email");

// Person match.
const jane = r.personEmails.find((p) => p.email === "jane.doe@acme.com");
ok(!!jane, "jane.doe is a person email");
ok(jane?.nameMatched === true, "jane.doe local-part matches the target name");

// Phone from tel:.
ok(r.phones.some((p) => p.replace(/\D/g, "") === "15551234567"), "extracts the tel: phone");

// Socials.
eq(r.socials.linkedin, "https://www.linkedin.com/company/acme-inc", "linkedin captured");
ok(!!r.socials.twitter, "twitter captured");

// Proximity name match (name near the address, not in the local part).
const prox = extractContacts(
  `<p>Our founder Maria Garcia can be reached at mg@founderco.com</p>`,
  { firstName: "Maria", lastName: "Garcia" },
);
const mg = prox.personEmails.find((p) => p.email === "mg@founderco.com");
ok(mg?.nameMatched === true, "proximity name match flags mg@ near 'Maria Garcia'");

// No target → nothing name-matched, but emails still split.
const noTarget = extractContacts(html);
ok(noTarget.personEmails.every((p) => p.nameMatched === false), "no target → no name matches");

// Placeholder rejection.
const junk = extractContacts(`<p>name@example.com you@yourdomain.com real@company.io</p>`);
ok(!junk.emails.includes("name@example.com"), "rejects name@example.com placeholder");
ok(!junk.emails.includes("you@yourdomain.com"), "rejects yourdomain placeholder");
ok(junk.emails.includes("real@company.io"), "keeps a real-looking address");

// --- Phone hardening: reject dates / year-ranges / bare ID runs, keep real phones.
const phoneHtml = `
<html><body>
  <p>&copy; 1996-2026 Acme. Founded 2004-02-07. Rev 20241128.</p>
  <a href="tel:+1 (555) 123-4567">Call us</a>
  <p>UK office: +44 20 7946 0018</p>
  <p>Order id 7183565168 shipped 20100401</p>
</body></html>`;
const ph = extractContacts(phoneHtml);
const phDigits = ph.phones.map((p) => p.replace(/\D/g, ""));
ok(phDigits.includes("15551234567"), "keeps the tel: phone");
ok(phDigits.includes("442079460018"), "keeps a +CC text phone");
ok(!phDigits.includes("19962026"), "rejects the 1996-2026 copyright range");
ok(!phDigits.includes("20040207"), "rejects the 2004-02-07 date");
ok(!phDigits.includes("20241128"), "rejects the 20241128 date stamp");
ok(!phDigits.includes("20100401"), "rejects the 20100401 date stamp");
ok(!phDigits.includes("7183565168"), "rejects a bare unformatted digit run");
ok(phDigits[0] === "15551234567", "tel: phone is listed first (what the provider writes)");

// --- Same-site trust: off-domain page noise is dropped, on-site kept, name-match wins.
const siteHtml = `
<html><body>
  <a href="mailto:john.smith@acme.com">John</a>
  <a href="mailto:info@acme.com">Info</a>
  <a href="mailto:service@partner.com">Partner desk</a>
  <a href="mailto:random@othersite.io">Random</a>
  <a href="mailto:jane.doe@gmail.com">Jane Doe (personal)</a>
</body></html>`;
const site = extractContacts(siteHtml, { firstName: "Jane", lastName: "Doe" }, "acme.com");
ok(site.companyEmails.includes("info@acme.com"), "on-site role → company email");
ok(!site.companyEmails.includes("service@partner.com"), "off-domain role inbox dropped");
ok(site.personEmails.some((p) => p.email === "john.smith@acme.com"), "on-site personal kept");
ok(!site.personEmails.some((p) => p.email === "random@othersite.io"), "off-domain unmatched personal dropped");
const jd = site.personEmails.find((p) => p.email === "jane.doe@gmail.com");
ok(!!jd && jd.nameMatched === true, "off-domain but name-matched personal kept + flagged");

// --- Extended role list: system/governance inboxes are company, not person.
const roleHtml = `
<html><body>
  <a href="mailto:webmasters@acme.com">WM</a>
  <a href="mailto:sysadmin@acme.com">SA</a>
  <a href="mailto:maintainers@acme.com">MNT</a>
  <a href="mailto:licensing@acme.com">LIC</a>
</body></html>`;
const roles = extractContacts(roleHtml, undefined, "acme.com");
ok(roles.companyEmails.length === 4, "webmasters/sysadmin/maintainers/licensing all classed as company");
ok(roles.personEmails.length === 0, "no role inbox leaks into personEmails");

console.log(`\nextract: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
