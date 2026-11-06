#!/usr/bin/env node
/**
 * Tests for who a reply from LeadStart goes to (src/lib/replies/recipients.ts):
 * the defaults (To the lead, Bcc the client's copy, "Re: <subject>"), an
 * owner/VA's edits from the admin Inbox (owner picks 2026-11-06: the client's
 * copy removable, admin Inbox only), and how the portal reads the recorded
 * lists back. Pure: no network, no DB.
 *
 * Usage:
 *   npx tsx scripts/test-reply-recipients.ts
 */

import {
  MAX_REPLY_FIELD_ADDRESSES,
  MAX_REPLY_RECIPIENTS,
  MAX_REPLY_SUBJECT_LENGTH,
  clientCopyAddresses,
  clientCopyWent,
  defaultReplyRecipients,
  defaultReplySubject,
  normalizeAddress,
  resolveReplyRecipients,
  resolveReplySubject,
  sameAddresses,
} from "../src/lib/replies/recipients.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

const client = { notification_email: " Hello@SaaSassinsDev.com ", notification_cc_emails: ["ops@polish.com", "hello@saasassinsdev.com", ""] };
const lead = "egarrison@commercialcleaningli.com";
const defaults = defaultReplyRecipients(lead, client);

console.log("\naddresses:");
assert(normalizeAddress(" Earl@Example.COM ") === "earl@example.com", "trimmed and lowercased");
assert(normalizeAddress("o'brien+ops@mail.example.co.uk") === "o'brien+ops@mail.example.co.uk", "apostrophe, plus and subdomains pass");
assert(normalizeAddress("Earl <earl@example.com>") === null, "a display name is refused (bare addresses only)");
assert(normalizeAddress("a@b.com, c@d.com") === null, "two addresses in one entry are refused");
assert(normalizeAddress("earl@example.com\r\nBcc: x@evil.com") === null, "a header injection is refused");
assert(normalizeAddress("earl@localhost") === null, "a domain with no dot is refused");
assert(normalizeAddress("") === null && normalizeAddress(42) === null, "blank or not text is refused");
assert(normalizeAddress(`${"a".repeat(250)}@x.com`) === null, "longer than 254 characters is refused");

console.log("\ndefaults:");
assert(
  clientCopyAddresses(client).join() === "hello@saasassinsdev.com,ops@polish.com",
  "client's copy: notification inbox first, then teammates, lowercased, deduped, blanks dropped",
);
assert(clientCopyAddresses(null).length === 0, "no client -> no copy");
assert(defaults.to.join() === lead && defaults.cc.length === 0, "To the lead, no Cc");
assert(defaults.bcc.join() === "hello@saasassinsdev.com,ops@polish.com", "Bcc the client's copy");
assert(
  defaultReplyRecipients("hello@saasassinsdev.com", client).bcc.join() === "ops@polish.com",
  "the lead is never also on Bcc",
);
assert(defaultReplyRecipients(null, client).to.length === 0, "no lead address -> nobody on To");
assert(defaultReplySubject("I'm canceling") === "Re: I'm canceling", "subject gets Re:");
assert(defaultReplySubject("RE: hello") === "RE: hello", "an existing Re: is kept, any case");
assert(defaultReplySubject("  ") === "Re: (no subject)" && defaultReplySubject(null) === "Re: (no subject)", "no subject -> Re: (no subject)");

console.log("\nedits:");
{
  const r = resolveReplyRecipients({}, defaults);
  assert(r.ok && sameAddresses(r.value.to, defaults.to) && sameAddresses(r.value.bcc, defaults.bcc), "nothing sent -> the defaults");
}
{
  const r = resolveReplyRecipients({ to: [lead], cc: ["Dana@CommercialCleaningLI.com"], bcc: [] }, defaults);
  assert(r.ok && r.value.cc.join() === "dana@commercialcleaningli.com", "a Cc is added, lowercased");
  assert(r.ok && r.value.bcc.length === 0, "the client's copy can be taken off (owner pick: removable)");
}
{
  const r = resolveReplyRecipients({ to: [lead], cc: ["hello@saasassinsdev.com"], bcc: ["ops@polish.com"] }, defaults);
  assert(r.ok && r.value.cc.join() === "hello@saasassinsdev.com" && r.value.bcc.join() === "ops@polish.com", "the client's copy can move to Cc");
}
{
  const r = resolveReplyRecipients({ to: ["dana@x.com"] }, defaults);
  assert(r.ok && r.value.to.join() === "dana@x.com", "To can be someone other than the lead");
  assert(r.ok && sameAddresses(r.value.bcc, defaults.bcc), "a field left out keeps its default");
}
{
  const r = resolveReplyRecipients({ to: [lead, lead.toUpperCase()], cc: [lead, "a@x.com"], bcc: ["a@x.com", "b@x.com"] }, defaults);
  assert(
    r.ok && r.value.to.join() === lead && r.value.cc.join() === "a@x.com" && r.value.bcc.join() === "b@x.com",
    "an address on two fields goes only on the first (To, then Cc, then Bcc)",
  );
}
{
  const r = resolveReplyRecipients({ to: [] }, defaults);
  assert(!r.ok && r.error === "Add at least one address on To.", "To can't be empty");
}
{
  const r = resolveReplyRecipients({ to: [lead], cc: ["not an address"] }, defaults);
  assert(!r.ok && r.error.includes('"not an address" in Cc'), "a bad address is named with its field");
}
{
  const r = resolveReplyRecipients({ to: "earl@x.com" }, defaults);
  assert(!r.ok && r.error === "To must be a list of addresses.", "a field that isn't a list is refused");
}
{
  const many = (p: string) => Array.from({ length: MAX_REPLY_FIELD_ADDRESSES }, (_, i) => `${p}${i}@x.com`);
  const r = resolveReplyRecipients({ to: [...many("t"), "one-more@x.com"] }, defaults);
  assert(!r.ok && r.error.includes(`at most ${MAX_REPLY_FIELD_ADDRESSES}`), `a field holds at most ${MAX_REPLY_FIELD_ADDRESSES}`);
  const ok = resolveReplyRecipients({ to: many("t"), cc: many("c"), bcc: [] }, defaults);
  assert(ok.ok && ok.value.to.length + ok.value.cc.length === MAX_REPLY_RECIPIENTS, `${MAX_REPLY_RECIPIENTS} in all is allowed`);
  const over = resolveReplyRecipients({ to: many("t"), cc: many("c"), bcc: ["b@x.com"] }, defaults);
  assert(!over.ok && over.error.includes(`at most ${MAX_REPLY_RECIPIENTS}`), `more than ${MAX_REPLY_RECIPIENTS} in all is refused`);
}

console.log("\nsubject:");
const fallback = defaultReplySubject("I'm canceling");
assert(resolveReplySubject(undefined, fallback).ok && (resolveReplySubject(undefined, fallback) as { value: string }).value === fallback, "not sent -> the default");
assert((resolveReplySubject("   ", fallback) as { value: string }).value === fallback, "blank -> the default");
assert((resolveReplySubject("  Your demo  ", fallback) as { value: string }).value === "Your demo", "an edited subject is used, trimmed");
assert((resolveReplySubject("Line one\r\nBcc: x@evil.com", fallback) as { value: string }).value === "Line one Bcc: x@evil.com", "line breaks become spaces");
assert(!resolveReplySubject("x".repeat(MAX_REPLY_SUBJECT_LENGTH + 1), fallback).ok, `longer than ${MAX_REPLY_SUBJECT_LENGTH} characters is refused`);
assert(!resolveReplySubject(7, fallback).ok, "a subject that isn't text is refused");

console.log("\nthe client's copy, read back:");
assert(clientCopyWent({ sent_to: null, sent_cc: null, sent_bcc: null }, client) === null, "not recorded (sent before 00141) -> null");
assert(clientCopyWent({ sent_to: [lead], sent_cc: [], sent_bcc: ["hello@saasassinsdev.com"] }, client) === "bcc", "on Bcc -> bcc");
assert(clientCopyWent({ sent_to: [lead], sent_cc: ["ops@polish.com"], sent_bcc: [] }, client) === "visible", "a teammate on Cc -> visible");
assert(clientCopyWent({ sent_to: [lead], sent_cc: [], sent_bcc: [] }, client) === "none", "taken off -> none");
assert(clientCopyWent({ sent_to: [lead], sent_cc: [], sent_bcc: ["HELLO@saasassinsdev.com"] }, client) === "bcc", "matched in any case");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
