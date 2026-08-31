#!/usr/bin/env node
/**
 * Unit tests for the live mailbox-tag reconciler's pure pool diff
 * (computeTagPoolDiff). No network, no DB. Run: npx tsx scripts/test-tag-pool-sync.ts
 *
 * The DB-touching syncCampaignTagPool wraps this diff with the tag resolution,
 * dedicated-inbox exclusion, and empty-pool guard — those are covered by the
 * route/cron behavior; here we lock the add/remove arithmetic that everything
 * else builds on.
 */
import { computeTagPoolDiff } from "../src/lib/campaigns/tag-pool-sync.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function sameSet(got: string[], want: string[], msg: string) {
  const g = [...got].sort().join(",");
  const w = [...want].sort().join(",");
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got [${g}], want [${w}])`);
  }
}

function diff(desired: string[], current: string[]) {
  return computeTagPoolDiff(desired, current);
}

console.log("computeTagPoolDiff");

// Nothing on either side.
{
  const d = diff([], []);
  sameSet(d.toAdd, [], "empty/empty → no adds");
  sameSet(d.toRemove, [], "empty/empty → no removes");
}

// Fresh bind: everything the tag holds is new.
{
  const d = diff(["a", "b"], []);
  sameSet(d.toAdd, ["a", "b"], "new tag members all added");
  sameSet(d.toRemove, [], "new bind removes nothing");
}

// The Instantly convenience: a new inbox joined the tag → only it is added.
{
  const d = diff(["a", "b"], ["a"]);
  sameSet(d.toAdd, ["b"], "newly-tagged inbox auto-joins");
  sameSet(d.toRemove, [], "existing member untouched");
}

// An inbox left the tag → dropped from the pool, nothing added.
{
  const d = diff(["a"], ["a", "b"]);
  sameSet(d.toAdd, [], "no adds when a member left");
  sameSet(d.toRemove, ["b"], "de-tagged inbox removed");
}

// Steady state: pool already matches the tag.
{
  const d = diff(["a", "b"], ["b", "a"]);
  sameSet(d.toAdd, [], "in-sync pool adds nothing");
  sameSet(d.toRemove, [], "in-sync pool removes nothing");
}

// Simultaneous churn: one joined, one left, one stayed.
{
  const d = diff(["b", "c"], ["a", "b"]);
  sameSet(d.toAdd, ["c"], "churn: added the joiner");
  sameSet(d.toRemove, ["a"], "churn: removed the leaver");
}

// Duplicates in either input must not produce duplicate ops.
{
  const d = diff(["a", "a", "b"], ["a"]);
  sameSet(d.toAdd, ["b"], "duplicate desired collapses");
  sameSet(d.toRemove, [], "duplicate desired removes nothing");
}

console.log("");
if (fail > 0) {
  console.error(`FAIL — ${pass} passed, ${fail} failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log(`OK — ${pass} passed`);
