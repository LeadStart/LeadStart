#!/usr/bin/env node
// Unit tests for extract.ts — pure, no network. Run: npx tsx test/extract.test.ts
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
  ok(JSON.stringify(a) === JSON.stringify(b), `${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
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

console.log(`\nextract: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
