#!/usr/bin/env node
/**
 * Unit tests for src/lib/deliverability/placement.ts: the pure half of
 * inbox-placement testing (folder classification, receiver-auth parsing,
 * roll-ups, probe copy). No network, no DB.
 *
 * Usage:
 *   npx tsx scripts/test-placement.ts
 */

import {
  classifyPlacement,
  classifyGraphPlacement,
  classifyImapPlacement,
  parseAuthenticationResults,
  isAuthFailure,
  stripMessageIdBrackets,
  summarizeResults,
  summarizeAuth,
  describeAuthFailures,
  describeCounts,
  buildNeutralProbe,
  NEUTRAL_PROBE_COUNT,
  placementStatusLabel,
} from "../src/lib/deliverability/placement.ts";
import type { PlacementResultStatus } from "../src/types/app.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// ---------- 1. Folder classification ----------
console.log("\n■ classifyPlacement");
{
  assert(classifyPlacement(["INBOX", "UNREAD", "CATEGORY_PERSONAL"]) === "inbox", "INBOX + Personal → inbox");
  assert(classifyPlacement(["INBOX", "CATEGORY_UPDATES"]) === "inbox", "INBOX + Updates → inbox (still the inbox)");
  assert(classifyPlacement(["INBOX", "CATEGORY_PROMOTIONS", "UNREAD"]) === "promotions", "INBOX + Promotions → promotions");
  assert(classifyPlacement(["SPAM", "UNREAD"]) === "spam", "SPAM → spam");
  assert(classifyPlacement(["SPAM", "INBOX"]) === "spam", "SPAM wins over a stray INBOX label");
  assert(classifyPlacement(["UNREAD"]) === "other", "present but not in inbox/spam → other");
  assert(classifyPlacement([]) === "other", "no labels → other");
  assert(classifyPlacement(null) === "other", "null labels → other");
}

// ---------- 1b. Microsoft Graph folder classification (migration 00085) ----------
console.log("\n■ classifyGraphPlacement");
{
  assert(classifyGraphPlacement("junkemail") === "spam", "junkemail → spam");
  assert(classifyGraphPlacement("inbox") === "inbox", "inbox → inbox");
  assert(classifyGraphPlacement("Archive") === "other", "archive folder → other");
  assert(classifyGraphPlacement("Client rules") === "other", "user-rule folder → other");
}

// ---------- 1c. IMAP classification (migration 00085) ----------
console.log("\n■ classifyImapPlacement");
{
  // Generic servers (Yahoo etc.): folder is the whole verdict.
  assert(classifyImapPlacement({ folder: "junk" }) === "spam", "generic junk → spam");
  assert(classifyImapPlacement({ folder: "inbox" }) === "inbox", "generic inbox → inbox");
  assert(classifyImapPlacement({ folder: null }) === "other", "no folder → other");
  // Gmail-over-IMAP: labels present, promotions verdict from the second search.
  assert(
    classifyImapPlacement({ folder: "inbox", gmLabels: ["\\Inbox"], promotionsHit: true }) ===
      "promotions",
    "gmail inbox + promotions hit → promotions",
  );
  assert(
    classifyImapPlacement({ folder: "inbox", gmLabels: ["\\Inbox"], promotionsHit: false }) ===
      "inbox",
    "gmail inbox, no promotions hit → inbox",
  );
  assert(
    classifyImapPlacement({ folder: "inbox", gmLabels: ["\\Inbox"], promotionsHit: null }) ===
      "inbox",
    "gmail inbox, promotions unknown → inbox (never guessed)",
  );
  assert(
    classifyImapPlacement({ folder: "archive", gmLabels: ["\\Important"] }) === "other",
    "gmail archived (no \\Inbox label) → other",
  );
  assert(classifyImapPlacement({ folder: "junk", gmLabels: [] }) === "spam", "gmail spam folder → spam");
}

// ---------- 2. Message-ID ----------
console.log("\n■ stripMessageIdBrackets");
{
  assert(stripMessageIdBrackets("<abc-123@example.com>") === "abc-123@example.com", "strips angle brackets");
  assert(stripMessageIdBrackets("  abc@x.y ") === "abc@x.y", "trims and leaves bare ids alone");
}

// ---------- 3. Authentication-Results parsing ----------
console.log("\n■ parseAuthenticationResults");
{
  const gmail =
    "mx.google.com;       dkim=pass header.i=@davidcabreraproperties.com header.s=google header.b=abc123;       spf=pass (google.com: domain of molly@davidcabreraproperties.com designates 209.85.220.41 as permitted sender) smtp.mailfrom=molly@davidcabreraproperties.com;       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=davidcabreraproperties.com";
  const a = parseAuthenticationResults(gmail);
  assert(a.spf === "pass", `spf parsed (got ${a.spf})`);
  assert(a.dkim === "pass", `dkim parsed (got ${a.dkim})`);
  assert(a.dmarc === "pass", `dmarc parsed (got ${a.dmarc})`);
  assert(!!a.raw && a.raw.startsWith("mx.google.com"), "raw header kept");

  const failing = "mx.google.com; dkim=fail (signature did not verify) header.i=@x.com; spf=softfail (google.com: ...) smtp.mailfrom=a@x.com; dmarc=fail (p=NONE) header.from=x.com";
  const b = parseAuthenticationResults(failing);
  assert(b.dkim === "fail" && b.spf === "softfail" && b.dmarc === "fail", "failure verdicts parsed");
  assert(isAuthFailure(b.dkim) && isAuthFailure(b.spf) && isAuthFailure(b.dmarc), "fail/softfail count as failures");
  assert(!isAuthFailure("pass") && !isAuthFailure("none") && !isAuthFailure(null), "pass/none/null are not failures");

  const multi = "mx.google.com; dkim=pass header.i=@first.com; dkim=fail header.i=@second.com; spf=pass";
  const c = parseAuthenticationResults(multi);
  assert(c.dkim === "pass", "first dkim verdict wins when several signatures are reported");

  const none = parseAuthenticationResults(null);
  assert(none.spf === null && none.dkim === null && none.dmarc === null && none.raw === null, "missing header → all null");

  const long = parseAuthenticationResults("x".repeat(2000));
  assert(!!long.raw && long.raw.length <= 601, "raw header is truncated");
}

// ---------- 4. Roll-ups ----------
console.log("\n■ summarizeResults / summarizeAuth");
{
  const rows = (
    ["inbox", "promotions", "spam", "missing", "bounced", "other", "pending", "send_failed", "unreadable"] as PlacementResultStatus[]
  ).map((status) => ({ status }));
  const c = summarizeResults(rows);
  assert(c.total === 7, `total counts readable seeds only (got ${c.total})`);
  assert(c.inbox === 1 && c.promotions === 1 && c.spam === 1, "inbox/promotions/spam tallied");
  assert(c.missing === 3, `missing = missing + bounced + other (got ${c.missing})`);
  assert(c.pending === 1, "pending tallied");
  assert(c.excluded === 2, `send_failed + unreadable excluded (got ${c.excluded})`);

  const auth = summarizeAuth([
    { auth_results: { spf: "pass", dkim: "pass", dmarc: "pass", raw: "" } },
    { auth_results: { spf: "pass", dkim: "fail", dmarc: "fail", raw: "" } },
    { auth_results: null },
    { auth_results: { spf: null, dkim: null, dmarc: null, raw: null } },
  ]);
  assert(auth.checked === 2, `only seeds with a verdict are counted (got ${auth.checked})`);
  assert(auth.dkim_fail === 1 && auth.dmarc_fail === 1 && auth.spf_fail === 0, "failure counts correct");
  assert(describeAuthFailures(auth) === "DKIM failed at 1 of 2, DMARC failed at 1 of 2", `describeAuthFailures (got "${describeAuthFailures(auth)}")`);
  assert(describeAuthFailures({ checked: 3, spf_fail: 0, dkim_fail: 0, dmarc_fail: 0 }) === "", "no failures → empty string");
  assert(describeAuthFailures(null) === "", "null → empty string");
}

// ---------- 5. describeCounts ----------
console.log("\n■ describeCounts");
{
  const d = (inbox: number, promotions: number, spam: number, missing: number) =>
    describeCounts({ total: inbox + promotions + spam + missing, inbox, promotions, spam, missing });
  assert(d(3, 0, 0, 0) === "3 of 3 seeds in the inbox", `all inbox (got "${d(3, 0, 0, 0)}")`);
  assert(d(1, 0, 0, 0) === "1 of 1 seed in the inbox", "singular seed");
  assert(d(1, 2, 0, 0) === "3 of 3 seeds in the inbox (2 in Promotions)", `promotions noted (got "${d(1, 2, 0, 0)}")`);
  assert(d(1, 0, 2, 0) === "2 of 3 seeds in spam (1 inbox)", `spam leads (got "${d(1, 0, 2, 0)}")`);
  assert(d(0, 0, 3, 0) === "3 of 3 seeds in spam", `all spam (got "${d(0, 0, 3, 0)}")`);
  assert(d(1, 0, 1, 1) === "1 of 3 seeds in spam (1 inbox, 1 missing)", `spam + missing (got "${d(1, 0, 1, 1)}")`);
  assert(d(2, 0, 0, 1) === "1 of 3 seeds missing (2 inbox)", `missing (got "${d(2, 0, 0, 1)}")`);
  assert(d(0, 0, 0, 0) === "No readable seeds", "zero total");
}

// ---------- 6. Probe copy ----------
console.log("\n■ buildNeutralProbe");
{
  assert(NEUTRAL_PROBE_COUNT >= 3, `has a rotation pool (got ${NEUTRAL_PROBE_COUNT})`);
  const subjects = new Set<string>();
  for (let i = 0; i < NEUTRAL_PROBE_COUNT; i++) {
    const p = buildNeutralProbe({ senderName: "Molly Anderson", variant: i });
    subjects.add(p.subject);
    assert(p.bodyText.includes("Molly Anderson"), `variant ${i} is signed by the sender`);
    assert(!/https?:\/\//i.test(p.bodyText), `variant ${i} contains no links`);
    assert(!/\btest\b/i.test(p.subject) && !/\btest\b/i.test(p.bodyText), `variant ${i} doesn't announce itself as a test`);
    assert(p.bodyText.length < 600, `variant ${i} is short (${p.bodyText.length} chars)`);
  }
  assert(subjects.size === NEUTRAL_PROBE_COUNT, "every variant has a distinct subject");
  const wrapped = buildNeutralProbe({ senderName: "X", variant: NEUTRAL_PROBE_COUNT + 1 });
  const direct = buildNeutralProbe({ senderName: "X", variant: 1 });
  assert(wrapped.subject === direct.subject, "variant index wraps around the pool");
  const negative = buildNeutralProbe({ senderName: "X", variant: -1 });
  assert(typeof negative.subject === "string" && negative.subject.length > 0, "negative variant is tolerated");
  const defaulted = buildNeutralProbe({ senderName: "X" });
  assert(defaulted.subject === buildNeutralProbe({ senderName: "X", variant: 0 }).subject, "no variant → first");
}

// ---------- 7. Labels ----------
console.log("\n■ placementStatusLabel");
{
  const all: PlacementResultStatus[] = ["pending", "inbox", "promotions", "spam", "other", "missing", "bounced", "send_failed", "unreadable"];
  assert(all.every((s) => placementStatusLabel(s).length > 0), "every status has a label");
  assert(placementStatusLabel("spam") === "Spam" && placementStatusLabel("promotions") === "Promotions", "labels read naturally");
}

// ---------- Summary ----------
console.log("\n" + "─".repeat(40));
if (fail === 0) {
  console.log(`✓ ${pass} assertions passed`);
  process.exit(0);
} else {
  console.error(`✗ ${fail} failed, ${pass} passed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
