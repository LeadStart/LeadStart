#!/usr/bin/env node
/**
 * Unit tests for the registrar pure core (spend cap, name generator, DNS
 * builders). No network, no DB. Run: npx tsx scripts/test-registrar.ts
 */
import { checkSpendCap, monthStartIso } from "../src/lib/registrar/spend.ts";
import { generateLookalikeDomains, DEFAULT_NAME_PATTERNS } from "../src/lib/registrar/names.ts";
import {
  gmailTierRecords,
  smtpTierRecords,
  diffDnsRecords,
  txtSlot,
  type DnsCurrentRecord,
} from "../src/lib/registrar/dns.ts";
import { toPorkbunRecord, fromPorkbunRecord } from "../src/lib/registrar/porkbun.ts";
import {
  toSpaceshipRecord,
  fromSpaceshipRecord,
  extractRegistrationPrice,
} from "../src/lib/registrar/spaceship.ts";

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
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

// ── checkSpendCap (fail-closed) ──────────────────────────────────────────────
console.log("checkSpendCap");
eq(checkSpendCap({ capUsd: null, monthToDateUsd: 0, priceUsd: 10 }).allowed, false, "no cap set → disabled (fail-closed)");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 0, priceUsd: 10 }).allowed, true, "$10 under $25 cap → allowed");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 20, priceUsd: 10 }).allowed, false, "$20 spent + $10 > $25 → refused");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 15, priceUsd: 10 }).allowed, true, "$15 spent + $10 = $25 exactly → allowed (boundary)");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 15.01, priceUsd: 10 }).allowed, false, "$15.01 + $10 = $25.01 > cap → refused");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 0, priceUsd: 0 }).allowed, false, "zero price → refused (invalid)");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 0, priceUsd: -5 }).allowed, false, "negative price → refused");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 10, priceUsd: 10 }).remainingUsd, 5, "remaining after purchase = 25-10-10 = 5");
eq(checkSpendCap({ capUsd: 25, monthToDateUsd: 30, priceUsd: 5 }).allowed, false, "already over cap → refused");

// ── monthStartIso ────────────────────────────────────────────────────────────
console.log("monthStartIso");
eq(monthStartIso(Date.UTC(2026, 7, 26, 14, 30)), "2026-08-01T00:00:00.000Z", "Aug 26 → Aug 1 00:00 UTC");
eq(monthStartIso(Date.UTC(2026, 0, 1, 0, 0)), "2026-01-01T00:00:00.000Z", "Jan 1 → Jan 1 00:00 UTC");

// ── generateLookalikeDomains ─────────────────────────────────────────────────
console.log("generateLookalikeDomains");
const gen = generateLookalikeDomains({ brand: "leadstart", limit: 3 });
eq(gen.length, 3, "limit respected");
eq(gen[0], "tryleadstart.com", "first pattern is tryleadstart.com");
eq(generateLookalikeDomains({ brand: "leadstart.com" }).includes("leadstart.com"), false, "never emits the exact input-as-domain");
eq(
  generateLookalikeDomains({ brand: "leadstart", excludePrimary: ["tryleadstart.com"] })[0] !== "tryleadstart.com",
  true,
  "excludePrimary drops that candidate",
);
eq(generateLookalikeDomains({ brand: "Lead Start!" })[0], "tryleadstart.com", "brand normalized (spaces + punctuation stripped)");
eq(generateLookalikeDomains({ brand: "acme.io" })[0], "tryacme.com", "a full domain input is reduced to its brand label");
eq(generateLookalikeDomains({ brand: "" }).length, 0, "empty brand → no candidates");
eq(
  generateLookalikeDomains({ brand: "acme", tlds: ["com", "co"] }).filter((d) => d.endsWith(".co")).length,
  DEFAULT_NAME_PATTERNS.length,
  "each tld gets every pattern",
);
{
  const all = generateLookalikeDomains({ brand: "acme", tlds: ["com", "com"] });
  eq(new Set(all).size, all.length, "no duplicate domains across repeated tlds");
}

// ── DNS builders ─────────────────────────────────────────────────────────────
console.log("gmailTierRecords");
{
  const recs = gmailTierRecords();
  const mx = recs.find((r) => r.type === "MX");
  eq(mx?.content, "smtp.google.com", "Google MX host");
  eq(mx?.priority, 1, "MX priority 1");
  eq(recs.some((r) => r.type === "TXT" && /include:_spf\.google\.com/.test(r.content)), true, "SPF authorizes Google");
  eq(recs.find((r) => r.name === "_dmarc")?.content, "v=DMARC1; p=none;", "DMARC starts at p=none");
  eq(gmailTierRecords({ dmarcRua: "dmarc@leadstart.io" }).find((r) => r.name === "_dmarc")?.content, "v=DMARC1; p=none; rua=mailto:dmarc@leadstart.io", "DMARC rua wired when provided");
}

console.log("smtpTierRecords");
{
  const recs = smtpTierRecords({ mailHost: "mail.tryacme.com", sendingIp: "203.0.113.5" });
  eq(recs.find((r) => r.type === "MX")?.content, "mail.tryacme.com", "SMTP MX = mail host");
  eq(recs.some((r) => r.type === "TXT" && r.content === "v=spf1 ip4:203.0.113.5 ~all"), true, "SPF authorizes the sending IP");
  eq(recs.some((r) => r.name.includes("_domainkey")), false, "no DKIM record until a key is supplied");
  const withDkim = smtpTierRecords({ mailHost: "mail.tryacme.com", sendingIp: "203.0.113.5", dkim: { selector: "mc", publicKey: "ABC" } });
  eq(withDkim.find((r) => r.name === "mc._domainkey")?.content, "v=DKIM1; k=rsa; p=ABC", "DKIM record built from selector+key");
}

// ── Porkbun record mapping ───────────────────────────────────────────────────
console.log("toPorkbunRecord");
{
  const txt = toPorkbunRecord({ type: "TXT", name: "", content: "v=spf1 ~all", ttl: 3600 });
  eq(txt.name, "", "TXT apex name blank");
  eq(txt.content, "v=spf1 ~all", "TXT content passthrough");
  eq(txt.ttl, "3600", "ttl stringified");
  eq("prio" in txt, false, "no prio on non-MX");
  const mx = toPorkbunRecord({ type: "MX", name: "", content: "smtp.google.com", priority: 1 });
  eq(mx.prio, "1", "MX priority → prio string");
}
console.log("fromPorkbunRecord");
{
  const r = fromPorkbunRecord({ name: "_dmarc.example.com", type: "TXT", content: "v=DMARC1", ttl: "3600" }, "example.com");
  eq(r.name, "_dmarc", "full host reduced to subdomain");
  eq(r.ttl, 3600, "ttl numified");
  const apex = fromPorkbunRecord({ name: "example.com", type: "MX", content: "smtp.google.com", prio: "1" }, "example.com");
  eq(apex.name, "", "apex host → blank name");
  eq(apex.priority, 1, "prio → priority number");
}

// ── Spaceship record mapping (per-type value field) ──────────────────────────
console.log("toSpaceshipRecord");
{
  const a = toSpaceshipRecord({ type: "A", name: "", content: "203.0.113.5" });
  eq(a.name, "@", "apex name → @");
  eq(a.address, "203.0.113.5", "A uses address field");
  eq(a.ttl, 3600, "default ttl 3600");
  const mx = toSpaceshipRecord({ type: "MX", name: "", content: "mail.x.com", priority: 10 });
  eq(mx.exchange, "mail.x.com", "MX uses exchange field");
  eq(mx.preference, 10, "MX preference from priority");
  eq(toSpaceshipRecord({ type: "TXT", name: "", content: "v=spf1" }).value, "v=spf1", "TXT uses value field");
  eq(toSpaceshipRecord({ type: "CNAME", name: "www", content: "x.com" }).cname, "x.com", "CNAME uses cname field");
}
console.log("fromSpaceshipRecord");
{
  const a = fromSpaceshipRecord({ type: "A", name: "@", address: "203.0.113.5", ttl: 3600 });
  eq(a.name, "", "@ → blank name");
  eq(a.content, "203.0.113.5", "A address → content");
  const mx = fromSpaceshipRecord({ type: "MX", name: "mail", exchange: "m.x.com", preference: 5, ttl: 3600 });
  eq(mx.content, "m.x.com", "MX exchange → content");
  eq(mx.priority, 5, "MX preference → priority");
  eq(fromSpaceshipRecord({ type: "TXT", name: "@", value: "v=DMARC1" }).content, "v=DMARC1", "TXT value → content");
}

// ── txtSlot ──────────────────────────────────────────────────────────────────
console.log("txtSlot");
eq(txtSlot("v=spf1 include:_spf.google.com ~all"), "spf", "SPF → spf slot");
eq(txtSlot("v=DMARC1; p=none;"), "dmarc", "DMARC → dmarc slot");
eq(txtSlot("google-site-verification=abc123"), "siteverif", "site-verification → siteverif slot");
eq(txtSlot("v=DKIM1; k=rsa; p=xyz"), "dkim", "DKIM → dkim slot");
eq(txtSlot("V=SPF1 include:x ~all"), "spf", "slot match is case-insensitive");
eq(txtSlot("MS=ms12345"), "exact:MS=ms12345", "unrelated TXT → its own exact slot");

// ── diffDnsRecords ───────────────────────────────────────────────────────────
console.log("diffDnsRecords");
const gmail = gmailTierRecords();
{
  const d = diffDnsRecords([], gmail);
  eq(d.create.length, 3, "empty zone → 3 creates");
  eq(d.edit.length + d.del.length + d.keep.length, 0, "empty zone → nothing else");
}
{
  // Idempotency: writing the same records twice must be a no-op.
  const current = gmail.map((r, i) => ({ ...r, providerId: String(i) })) as DnsCurrentRecord[];
  const d = diffDnsRecords(current, gmail);
  eq(d.keep.length, 3, "identical zone → 3 keeps");
  eq(d.create.length + d.edit.length + d.del.length, 0, "identical zone → no writes (idempotent)");
}
{
  // A stale SPF value is replaced (edit), MX + DMARC untouched (keep).
  const current = [
    { type: "MX", name: "", content: "smtp.google.com", priority: 1, providerId: "m" },
    { type: "TXT", name: "", content: "v=spf1 include:spf.old.com ~all", providerId: "s" },
    { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none;", providerId: "d" },
  ] as DnsCurrentRecord[];
  const d = diffDnsRecords(current, gmail);
  eq(d.edit.length, 1, "stale SPF → 1 edit");
  eq(d.edit[0].current.providerId, "s", "edit targets the existing SPF record's id");
  eq(d.keep.length, 2, "matching MX + DMARC kept");
  eq(d.create.length + d.del.length, 0, "stale SPF → no create/del");
}
{
  // An unrelated apex TXT (another vendor's verification token) is never deleted.
  const current = [
    { type: "TXT", name: "", content: "MS=ms12345", providerId: "x" },
  ] as DnsCurrentRecord[];
  const d = diffDnsRecords(current, gmail);
  eq(d.del.length, 0, "TXT is never deleted");
  eq(d.keep.some((r) => r.content === "MS=ms12345"), true, "unrelated apex TXT preserved");
  eq(d.create.length, 3, "all gmail records created alongside it");
}
{
  // A registrar's parked-domain default MX at the apex is a stray → deleted.
  const current = [
    { type: "MX", name: "", content: "pixie.porkbun.com", priority: 0, providerId: "p" },
  ] as DnsCurrentRecord[];
  const d = diffDnsRecords(current, gmail);
  eq(d.del.length, 1, "stray parked MX → 1 delete");
  eq(d.del[0].providerId, "p", "delete targets the stray MX id");
  eq(
    d.create.some((r) => r.type === "MX" && r.content === "smtp.google.com"),
    true,
    "the google MX is created",
  );
}
{
  // Records in a group the desired set never mentions (an apex A record) are left alone.
  const current = [
    { type: "A", name: "", content: "203.0.113.5", providerId: "a" },
  ] as DnsCurrentRecord[];
  const d = diffDnsRecords(current, gmail);
  eq(d.keep.some((r) => r.type === "A"), true, "untouched A record kept");
  eq(d.del.length, 0, "A record not deleted (its group isn't in the desired set)");
}
{
  // Site-verification: an old google-site-verification value is replaced, SPF kept.
  const desired = [
    { type: "TXT" as const, name: "", content: "google-site-verification=NEWTOKEN" },
    ...gmail,
  ];
  const current = [
    { type: "TXT", name: "", content: "google-site-verification=OLDTOKEN", providerId: "gsv" },
    { type: "TXT", name: "", content: "v=spf1 include:_spf.google.com ~all", providerId: "s" },
  ] as DnsCurrentRecord[];
  const d = diffDnsRecords(current, desired);
  eq(
    d.edit.some((e) => e.current.providerId === "gsv" && e.desired.content === "google-site-verification=NEWTOKEN"),
    true,
    "old site-verification token replaced in place",
  );
  eq(d.keep.some((r) => r.providerId === "s"), true, "matching SPF kept, not duplicated");
}

// ── extractRegistrationPrice (Spaceship price-parse fix) ─────────────────────
console.log("extractRegistrationPrice");
eq(extractRegistrationPrice(null), null, "null → null");
eq(extractRegistrationPrice({}), null, "empty object → null");
eq(extractRegistrationPrice({ price: 10.99 }), 10.99, "bare price number");
eq(extractRegistrationPrice({ price: { registration: 12 } }), 12, "price.registration nested");
eq(extractRegistrationPrice({ registrationPrice: 9 }), 9, "registrationPrice field");
eq(extractRegistrationPrice({ pricing: { registration: { price: 8.5 } } }), 8.5, "pricing.registration.price");
eq(extractRegistrationPrice({ pricing: { registration: 7.25 } }), 7.25, "pricing.registration as a number");
eq(
  extractRegistrationPrice({ premiumPricing: [{ operation: "register", price: 250 }] }),
  250,
  "premiumPricing register fallback (the old-only path)",
);
eq(extractRegistrationPrice({ price: 0, registrationPrice: 11 }), 11, "non-positive price skipped, next candidate wins");
eq(extractRegistrationPrice({ foo: "bar" }), null, "no known field → null (keeps the refuse-to-buy-blind guard)");

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
