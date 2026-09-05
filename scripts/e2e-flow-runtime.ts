#!/usr/bin/env node
/**
 * Light e2e for the graph runtime against the LIVE DB: entirely on a DRAFT
 * campaign (prod's every-5-min cron filters status='active', so it never touches
 * this) with a .invalid recipient (zero real sends, zero spend). Proves the DB
 * integration the unit tests can't: a flow_graph round-trips through JSONB, the
 * walker routes on REAL signals read from real tables, createManualTask writes a
 * real manual_tasks row and its flow_node dedup works, and a reply re-routes to
 * the YES arm (internal notify). Cleans up everything it creates.
 *
 *   npx tsx scripts/e2e-flow-runtime.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  resolveFlowAction,
  type FlowSignals,
} from "../src/lib/flow/runtime.ts";
import {
  emailNode,
  waitNode,
  linkedinNode,
  internalNode,
  conditionNode,
  graphToSteps,
  type FlowGraph,
} from "../src/lib/flow/graph.ts";
import {
  createManualTask,
  manualTaskKindForLinkedIn,
} from "../src/lib/manual-tasks/create.ts";

function loadEnvLocal() {
  const raw = readFileSync(".env.local", "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=("?)(.*?)\2\s*$/);
    if (m) env[m[1]] = m[3];
  }
  return env;
}
const env = loadEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.log(`  ✗ ${msg}${extra !== undefined ? `, ${JSON.stringify(extra)}` : ""}`);
  }
}

// ── The branched graph under test ─────────────────────────────────────────────
//   E1(email) → C1(replied?)
//                 yes → INT1(notify)
//                 no  → W1(wait 0) → LI1(linkedin) → E2(email follow-up)
const GRAPH: FlowGraph = {
  version: 1,
  nodes: [
    emailNode("Hi {{first_name}}", "First touch for {{company}}.", "E1"),
    conditionNode(
      "replied",
      [internalNode("notify", "Ping the account manager", "INT1")],
      [
        waitNode(0, "W1"),
        linkedinNode("connect_request", "Connect, {{first_name}}?", "LI1"),
        emailNode("", "Following up.", "E2"),
      ],
      "C1",
    ),
  ],
};
const NEITHER: FlowSignals = { hasReplied: false, hasBounced: false, replyClass: null };
const REPLIED: FlowSignals = { hasReplied: true, hasBounced: false, replyClass: null };

async function main() {
  // Attach to a real org via any existing client (campaign.client_id is denormed
  // onto manual_tasks). Read-only pick.
  const { data: clientRow, error: clientErr } = await admin
    .from("clients")
    .select("id, organization_id")
    .limit(1)
    .maybeSingle();
  if (clientErr || !clientRow) {
    console.error("Could not find a client to attach the test to:", clientErr);
    process.exit(1);
  }
  const orgId = (clientRow as { organization_id: string }).organization_id;
  const clientId = (clientRow as { id: string }).id;
  console.log(`Using org ${orgId}, client ${clientId}`);

  let campaignId: string | null = null;
  let contactId: string | null = null;
  let enrollmentId: string | null = null;

  try {
    // ---- Seed: DRAFT campaign carrying the graph + its derived steps ----
    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .insert({
        organization_id: orgId,
        client_id: clientId,
        name: `E2E graph-runtime ${Date.now()}`,
        status: "draft", // prod's active-only cron never touches this
        source_channel: "native_email",
        flow_graph: GRAPH,
      })
      .select("id")
      .single();
    if (campErr) throw new Error(`campaign insert: ${campErr.message}`);
    campaignId = (camp as { id: string }).id;

    const steps = graphToSteps(GRAPH);
    const { error: stepsErr } = await admin.from("campaign_steps").insert(
      steps.map((s, i) => ({
        campaign_id: campaignId,
        step_index: i,
        kind: "email" as const,
        wait_days: s.wait_days,
        subject_template: i === 0 ? s.subject_template : s.subject_template,
        body_template: s.body_template,
      })),
    );
    if (stepsErr) throw new Error(`steps insert: ${stepsErr.message}`);

    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        organization_id: orgId,
        first_name: "Casey",
        last_name: "Tester",
        email: `graph-runtime-e2e+${Date.now()}@example.invalid`,
        company_name: "Invalid Co",
        status: "active",
        source: "e2e",
      })
      .select("id")
      .single();
    if (contactErr) throw new Error(`contact insert: ${contactErr.message}`);
    contactId = (contact as { id: string }).id;

    const { data: enr, error: enrErr } = await admin
      .from("campaign_enrollments")
      .insert({
        campaign_id: campaignId,
        contact_id: contactId,
        current_step_index: 1, // pretend E1 already sent
        current_node_id: "E1", // parked just after the first email
        status: "active",
        last_action_at: new Date(Date.now() - 86_400_000).toISOString(),
      })
      .select("id")
      .single();
    if (enrErr) throw new Error(`enrollment insert: ${enrErr.message}`);
    enrollmentId = (enr as { id: string }).id;

    console.log("\nSeeded draft campaign + contact + enrollment (parked at E1).");

    // ---- Re-read the graph from JSONB and walk it (round-trip) ----
    const { data: campRead } = await admin
      .from("campaigns")
      .select("flow_graph")
      .eq("id", campaignId)
      .single();
    const storedGraph = (campRead as { flow_graph: FlowGraph }).flow_graph;
    ok(Array.isArray(storedGraph?.nodes) && storedGraph.nodes.length === 2, "flow_graph round-trips through JSONB");

    // Signals: read exactly as the cron does.
    const { data: c } = await admin
      .from("contacts")
      .select("status, email")
      .eq("id", contactId)
      .single();
    const status = (c as { status: string }).status;
    const email = (c as { email: string | null }).email?.trim().toLowerCase() ?? "";
    const { data: replies } = await admin
      .from("lead_replies")
      .select("id")
      .eq("campaign_id", campaignId)
      .eq("lead_email", email);
    const hasReplied = status === "replied" || (replies?.length ?? 0) > 0;
    const signals: FlowSignals = { hasReplied, hasBounced: status === "bounced", replyClass: null };
    ok(!signals.hasReplied, "not-replied signal computed from real tables");

    // Walk from the stored position (parked at E1) with the not-replied signal.
    const action = resolveFlowAction(
      storedGraph,
      { currentNodeId: "E1", emailsSent: 1 },
      signals,
    );
    ok(action.type === "linkedin" && action.node.id === "LI1", "not replied → routes to the LinkedIn node (NO arm)", action);

    // ---- createManualTask writes a real row (and dedups) ----
    if (action.type === "linkedin") {
      const t1 = await createManualTask(admin, {
        organizationId: orgId,
        campaignId: campaignId!,
        contactId: contactId!,
        kind: manualTaskKindForLinkedIn(action.node.li_kind),
        renderedBody: `Connect, Casey?`,
        clientId,
        flowNodeId: action.node.id,
      });
      ok(t1.created && !!t1.id, "createManualTask inserted an OPEN manual_tasks row", t1);

      const { data: taskRow } = await admin
        .from("manual_tasks")
        .select("kind, status, flow_node_id, client_id, campaign_id, contact_id")
        .eq("id", t1.id!)
        .single();
      ok(
        !!taskRow &&
          (taskRow as { kind: string }).kind === "linkedin_connect" &&
          (taskRow as { status: string }).status === "open" &&
          (taskRow as { flow_node_id: string }).flow_node_id === "LI1",
        "manual_tasks row has the right kind/status/flow_node_id",
        taskRow,
      );

      const t2 = await createManualTask(admin, {
        organizationId: orgId,
        campaignId: campaignId!,
        contactId: contactId!,
        kind: manualTaskKindForLinkedIn(action.node.li_kind),
        renderedBody: `Connect, Casey?`,
        clientId,
        flowNodeId: action.node.id,
      });
      ok(!t2.created && !t2.error, "second createManualTask for the same node dedups (created:false, no error)", t2);
    }

    // ---- Advancing past LI1 → the follow-up email ----
    const afterLi = resolveFlowAction(storedGraph, { currentNodeId: "LI1", emailsSent: 1 }, signals);
    ok(afterLi.type === "email" && afterLi.node.id === "E2", "after the LinkedIn node → the follow-up email E2", afterLi);

    // ---- Flip the contact to replied → the walk re-routes to the internal node ----
    await admin.from("contacts").update({ status: "replied" }).eq("id", contactId);
    const repliedAction = resolveFlowAction(storedGraph, { currentNodeId: "E1", emailsSent: 1 }, REPLIED);
    ok(
      repliedAction.type === "internal" && repliedAction.node.id === "INT1",
      "replied → re-routes to the internal notify node (YES arm): the helper WOULD fire",
      repliedAction,
    );
    ok(
      repliedAction.type === "internal" && repliedAction.node.action === "notify",
      "the routed internal node is the notify action runInternalNode handles",
    );
    // Restore, and confirm the not-replied walk is stable (NEITHER == real signal).
    await admin.from("contacts").update({ status: "active" }).eq("id", contactId);
    const stable = resolveFlowAction(storedGraph, { currentNodeId: "E1", emailsSent: 1 }, NEITHER);
    ok(stable.type === "linkedin", "restored not-replied → back to the LinkedIn arm");
  } finally {
    // ---- Cleanup: delete everything we created ----
    console.log("\nCleaning up…");
    if (contactId) await admin.from("manual_tasks").delete().eq("contact_id", contactId);
    if (enrollmentId) await admin.from("campaign_enrollments").delete().eq("id", enrollmentId);
    if (campaignId) await admin.from("campaign_steps").delete().eq("campaign_id", campaignId);
    if (contactId) await admin.from("contacts").delete().eq("id", contactId);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);

    // Verify cleanup left nothing behind.
    if (campaignId) {
      const { count: campLeft } = await admin
        .from("campaigns")
        .select("id", { count: "exact", head: true })
        .eq("id", campaignId);
      const { count: taskLeft } = await admin
        .from("manual_tasks")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId);
      ok((campLeft ?? 0) === 0 && (taskLeft ?? 0) === 0, "cleanup removed the draft campaign + its tasks");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
