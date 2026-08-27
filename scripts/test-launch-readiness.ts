#!/usr/bin/env node
/**
 * Unit tests for the launch-readiness rule (create-flow relaxation feature).
 * No network, no DB. Run: npx tsx scripts/test-launch-readiness.ts
 */
import {
  computeLaunchReadiness,
  type ReadinessInput,
} from "../src/lib/campaigns/launch-readiness.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = typeof got === "object" ? JSON.stringify(got) : got;
  const w = typeof want === "object" ? JSON.stringify(want) : want;
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
  }
}

const ready: ReadinessInput = {
  clientId: "c1",
  poolMailboxCount: 2,
  connectedMailboxCount: 1,
  stepCount: 3,
  firstStepHasSubject: true,
  firstStepHasBody: true,
  contactCount: 10,
};

console.log("computeLaunchReadiness");
{
  const r = computeLaunchReadiness(ready);
  eq(r.canLaunch, true, "fully-configured campaign can launch");
  eq(r.blockers.length, 0, "no blockers when ready");
  eq(r.warnings.length, 0, "no warnings when ready");
}
{
  const r = computeLaunchReadiness({
    clientId: null,
    poolMailboxCount: 0,
    connectedMailboxCount: 0,
    stepCount: 0,
    firstStepHasSubject: false,
    firstStepHasBody: false,
    contactCount: 0,
  });
  eq(r.canLaunch, false, "empty draft cannot launch");
  eq(r.blockers.map((b) => b.key).sort().join(","), "client,mailbox,steps", "empty draft blocks on client + steps + mailbox");
  eq(r.warnings.map((w) => w.key).join(","), "contacts", "empty draft warns on no contacts");
}
eq(
  computeLaunchReadiness({ ...ready, clientId: null }).blockers.map((b) => b.key),
  ["client"],
  "client is a hard blocker",
);
eq(
  computeLaunchReadiness({ ...ready, firstStepHasSubject: false }).blockers.map((b) => b.key),
  ["subject"],
  "steps present but no first subject → subject blocker",
);
eq(
  computeLaunchReadiness({ ...ready, stepCount: 0, firstStepHasSubject: false }).blockers.map((b) => b.key),
  ["steps"],
  "no steps → steps blocker (not subject)",
);
eq(
  computeLaunchReadiness({ ...ready, firstStepHasBody: false }).blockers.map((b) => b.key),
  ["body"],
  "subject present but empty body → body blocker",
);
{
  // A mailbox attached but not connected still blocks, with the connect-specific copy.
  const r = computeLaunchReadiness({ ...ready, poolMailboxCount: 1, connectedMailboxCount: 0 });
  eq(r.blockers.map((b) => b.key), ["mailbox"], "attached-but-disconnected mailbox blocks");
  eq(r.blockers[0].label.includes("Connect"), true, "disconnected mailbox → 'Connect' copy");
}
eq(
  computeLaunchReadiness({ ...ready, poolMailboxCount: 0, connectedMailboxCount: 0 }).blockers[0].label.includes("Add"),
  true,
  "no mailbox at all → 'Add' copy",
);
eq(
  computeLaunchReadiness({ ...ready, contactCount: 0 }).canLaunch,
  true,
  "no contacts is a WARNING, not a blocker — can still launch",
);

console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) {
  console.log("FAILURES:\n" + failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}
