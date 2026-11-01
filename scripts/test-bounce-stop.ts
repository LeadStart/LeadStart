#!/usr/bin/env node
/**
 * Tests for the campaign bounce stop (src/lib/campaigns/bounce-stop.ts) and the
 * reply checker's Message-ID match (replyParentIds in src/lib/gmail/mime.ts).
 * Pure: no network, no DB.
 *
 * Replayed on PolishPoint's real first emails (2026-11-01, read-only): as sent,
 * the stop would have paused new contacts at 4:28 PM PDT on launch day, after 3
 * of the first 9 bounced; with the catch-alls held it would still have tripped
 * on Oct 27 at 3:21 PM PDT (3 of 75).
 *
 * Usage:
 *   npx tsx scripts/test-bounce-stop.ts
 */

import {
  bounceStopVerdict,
  isBadAddressBounce,
  BOUNCE_STOP_LIMIT,
  BOUNCE_STOP_WINDOW,
  BAD_ADDRESS_CLASSES,
  type FirstEmailRow,
} from "../src/lib/campaigns/bounce-stop.ts";
import { replyParentIds } from "../src/lib/gmail/mime.ts";
import type { NativeBounceClass } from "../src/types/app.ts";

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

const sent = (): FirstEmailRow => ({ status: "sent", bounce_class: null });
const bounced = (c: NativeBounceClass): FirstEmailRow => ({ status: "bounced", bounce_class: c });
const many = (n: number, f: () => FirstEmailRow) => Array.from({ length: n }, f);

console.log("\nthe rule:");
assert(BOUNCE_STOP_LIMIT === 3 && BOUNCE_STOP_WINDOW === 100, "3 bad-address bounces in the last 100 first emails (owner pick 2026-11-01)");
assert(
  BAD_ADDRESS_CLASSES.join() === "invalid_address,mailbox_unavailable,unreachable",
  "bad address = doesn't exist, disabled or full, domain or tenant gone",
);
assert(isBadAddressBounce(bounced("invalid_address")), "invalid_address counts");
assert(isBadAddressBounce(bounced("mailbox_unavailable")), "mailbox_unavailable counts (disabled, full)");
assert(isBadAddressBounce(bounced("unreachable")), "unreachable counts (dead domain, Microsoft tenant with no mail)");
assert(!isBadAddressBounce(bounced("spam_block")), "spam_block doesn't count (reputation, alerts on its own)");
assert(!isBadAddressBounce(bounced("auth_failure")), "auth_failure doesn't count (alerts on its own)");
assert(!isBadAddressBounce(bounced("policy_block")), "policy_block doesn't count (e.g. external forwarding refused)");
assert(!isBadAddressBounce({ status: "sent", bounce_class: "invalid_address" }), "a class on a row not bounced doesn't count");

console.log("\nverdicts:");
assert(!bounceStopVerdict([]).trip, "no first emails -> no trip");
assert(!bounceStopVerdict([bounced("invalid_address"), bounced("invalid_address"), ...many(98, sent)]).trip, "2 in 100 -> no trip");
{
  const v = bounceStopVerdict([bounced("invalid_address"), sent(), bounced("unreachable"), ...many(5, sent), bounced("mailbox_unavailable")]);
  assert(v.trip && v.bad === 3 && v.looked === 9, "launch-day shape: 3 of the first 9 -> trip");
}
{
  // newest first: 3 bounces older than the last 100 fall out of the window
  const v = bounceStopVerdict([...many(100, sent), bounced("invalid_address"), bounced("invalid_address"), bounced("invalid_address")]);
  assert(!v.trip && v.looked === 100, "bounces older than the last 100 first emails don't count");
}
{
  const v = bounceStopVerdict([bounced("policy_block"), bounced("spam_block"), bounced("invalid_address"), bounced("invalid_address"), ...many(20, sent)]);
  assert(!v.trip && v.bad === 2, "only bad-address classes count toward 3");
}

console.log("\nreply matching by Message-ID (replyParentIds):");
{
  // An Outlook out-of-office: Gmail filed it in a thread of its own; its headers still name our email.
  const ids = replyParentIds({
    inReplyTo: "<CAMaL1+9N+bnh32@mail.gmail.com>",
    references: "<CAMaL1+9N+bnh32@mail.gmail.com>",
  });
  assert(ids.length === 1 && ids[0] === "<CAMaL1+9N+bnh32@mail.gmail.com>", "In-Reply-To and References naming one email -> that id once");
}
{
  const ids = replyParentIds({ inReplyTo: "<c@x.com>", references: "<a@x.com> <b@x.com> <c@x.com>" });
  assert(ids.join(" ") === "<c@x.com> <b@x.com> <a@x.com>", "direct parent first, then References newest first");
}
assert(replyParentIds({ inReplyTo: null, references: null }).length === 0, "no headers -> no ids");
assert(replyParentIds({ inReplyTo: "not an id", references: "" }).length === 0, "junk headers -> no ids");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
