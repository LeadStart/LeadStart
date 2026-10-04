#!/usr/bin/env node
/**
 * Unit tests for the campaign lifecycle rules (src/lib/campaigns/lifecycle.ts):
 * which status pause / resume / complete may start from, the refusal text the
 * routes return, and the reopen-conflict message. No network, no DB.
 * Run: npx tsx scripts/test-campaign-lifecycle.ts
 *
 * The DB-touching helpers (lifecycleSummary, reopenConflicts) wrap
 * mailboxUsageMap: those are covered by the routes and
 * scripts/audit-native-campaign-completion.mjs; here we lock the transition
 * table every route and control builds on.
 */
import {
  canTransition,
  reopenConflictMessage,
  transitionRefusal,
  type LifecycleAction,
} from "../src/lib/campaigns/lifecycle.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(ok: boolean, msg: string, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail ? ` (${detail})` : ""}`);
  }
}

const STATUSES = ["draft", "active", "paused", "completed", null, undefined, "archived"] as const;
const ALLOWED: Record<LifecycleAction, string[]> = {
  pause: ["active"],
  resume: ["paused", "completed"],
  complete: ["active", "paused"],
};

console.log("canTransition / transitionRefusal agree with the table");
for (const action of Object.keys(ALLOWED) as LifecycleAction[]) {
  for (const status of STATUSES) {
    const want = typeof status === "string" && ALLOWED[action].includes(status);
    const got = canTransition(action, status);
    const refusal = transitionRefusal(action, status);
    check(got === want, `${action} from ${String(status)} → ${want ? "allowed" : "refused"}`);
    check(
      want ? refusal === null : typeof refusal === "string" && refusal.length > 0,
      `${action} from ${String(status)}: refusal text ${want ? "absent" : "present"}`,
      `got ${JSON.stringify(refusal)}`,
    );
  }
}

console.log("refusal text points at the right next step");
check(transitionRefusal("pause", "paused") === "Campaign is already paused.", "pause a paused campaign");
check(transitionRefusal("resume", "active") === "Campaign is already active.", "resume an active campaign");
check(/Launch/.test(transitionRefusal("resume", "draft") ?? ""), "resume a draft points to Launch");
check(/Delete/.test(transitionRefusal("complete", "draft") ?? ""), "complete a draft points to Delete");
check(transitionRefusal("complete", "completed") === "Campaign is already completed.", "complete twice");
check(/unknown/.test(transitionRefusal("complete", null) ?? ""), "null status is named, not blank");

console.log("reopenConflictMessage");
{
  const one = reopenConflictMessage([{ mailboxId: "m1", email: "a@x.com", campaignName: "Campaign B" }]);
  check(one.startsWith("Can't reopen yet. One of its inboxes is"), "one conflict reads singular", one);
  check(one.includes('a@x.com ("Campaign B")'), "names the inbox and the campaign holding it", one);
  check(one.includes("take it out"), "singular pronoun", one);
}
{
  const two = reopenConflictMessage([
    { mailboxId: "m1", email: "a@x.com", campaignName: "Campaign B" },
    { mailboxId: "m2", email: "b@x.com", campaignName: "Campaign C" },
  ]);
  check(two.includes("2 of its inboxes are"), "two conflicts read plural", two);
  check(two.includes('a@x.com ("Campaign B"), b@x.com ("Campaign C")'), "lists every conflict", two);
  check(two.includes("take them out"), "plural pronoun", two);
}
const DASHES = new RegExp("[" + String.fromCharCode(0x2014, 0x2013) + "]");
check(!DASHES.test(reopenConflictMessage([{ mailboxId: "m", email: "e", campaignName: "n" }])), "no em or en dashes in the message");

console.log("");
if (fail > 0) {
  console.error(`FAIL, ${pass} passed, ${fail} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`OK, ${pass} passed`);
