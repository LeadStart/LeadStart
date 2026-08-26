#!/usr/bin/env node
/**
 * Unit tests for the registrar pure core (spend cap, name generator, DNS
 * builders). No network, no DB. Run: npx tsx scripts/test-registrar.ts
 */
import { checkSpendCap, monthStartIso } from "../src/lib/registrar/spend.ts";
import { generateLookalikeDomains, DEFAULT_NAME_PATTERNS } from "../src/lib/registrar/names.ts";
import { gmailTierRecords, smtpTierRecords } from "../src/lib/registrar/dns.ts";
import { toPorkbunRecord, fromPorkbunRecord } from "../src/lib/registrar/porkbun.ts";
import { toSpaceshipRecord, fromSpaceshipRecord } from "../src/lib/registrar/spaceship.ts";

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

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
