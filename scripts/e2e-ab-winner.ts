#!/usr/bin/env node
/**
 * Light e2e for the A/B auto-winner against the LIVE DB — entirely on a DRAFT
 * campaign (prod's hourly sync-analytics filters status='active', so it never
 * touches this) with .invalid recipients (zero real sends, zero spend). Proves
 * the DB integration the unit tests can't: real native_sends + lead_replies rows
 * drive the SAME evaluateAbWinners the cron runs, the pause is written into
 * campaigns.flow_graph and round-trips through JSONB, the sender's pickVariant
 * then excludes the paused variant for new leads yet stays sticky for an
 * already-assigned one, a manual re-save preserves the pause (mergeStoredPauses),
 * and a second pass is idempotent. Cleans up everything it creates.
 *
 * The seeded node carries a small ab_config so a handful of rows crosses the
 * threshold; production uses DEFAULT_AB_WINNER_CONFIG (30/60/0.95).
 *
 *   npx tsx scripts/e2e-ab-winner.ts
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import {
  emailNode,
  emailVariant,
  emailVariants,
  type FlowGraph,
  type EmailNode,
} from "../src/lib/flow/graph.ts";
import { pickVariant } from "../src/lib/flow/variants.ts";
import { mergeStoredPauses } from "../src/lib/flow/ab-winner.ts";
import { evaluateAbWinners } from "../src/lib/flow/ab-winner-eval.ts";

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
    console.log(`  ✗ ${msg}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  }
}

// A/B on the first email: A ("E1") vs B ("VB"). Small ab_config so ~10 rows decide.
function buildGraph(): FlowGraph {
  const e1 = emailNode("Subject A {{first_name}}", "Body A for {{company}}.", "E1");
  e1.variants = [emailVariant("Subject B {{first_name}}", "Body B for {{company}}.", "VB")];
  e1.ab_config = { minSentPerVariant: 4, minTotalSent: 8, confidence: 0.95 };
  return { version: 1, nodes: [e1] };
}

async function main() {
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

  const stamp = Date.now();
  let campaignId: string | null = null;
  let contactId: string | null = null;
  let mailboxId: string | null = null;

  try {
    const GRAPH = buildGraph();

    // ---- Seed: mailbox + contact + DRAFT campaign carrying the A/B graph ----
    const { data: mb, error: mbErr } = await admin
      .from("native_mailboxes")
      .insert({ organization_id: orgId, email_address: `ab-winner-e2e+${stamp}@example.invalid` })
      .select("id")
      .single();
    if (mbErr) throw new Error(`mailbox insert: ${mbErr.message}`);
    mailboxId = (mb as { id: string }).id;

    const { data: contact, error: contactErr } = await admin
      .from("contacts")
      .insert({
        organization_id: orgId,
        first_name: "Casey",
        last_name: "Tester",
        email: `ab-winner-e2e-contact+${stamp}@example.invalid`,
        company_name: "Invalid Co",
        status: "active",
        source: "e2e",
      })
      .select("id")
      .single();
    if (contactErr) throw new Error(`contact insert: ${contactErr.message}`);
    contactId = (contact as { id: string }).id;

    const { data: camp, error: campErr } = await admin
      .from("campaigns")
      .insert({
        organization_id: orgId,
        client_id: clientId,
        name: `E2E ab-winner ${stamp}`,
        status: "draft", // prod's active-only cron never touches this
        source_channel: "native_email",
        flow_graph: GRAPH,
        ab_auto_pause_default: false, // node inherits this → starts OFF
      })
      .select("id")
      .single();
    if (campErr) throw new Error(`campaign insert: ${campErr.message}`);
    campaignId = (camp as { id: string }).id;

    // ---- Seed sends: A gets 5 (3 positive), B gets 5 (0 positive) ----
    const emailFor = (v: "a" | "b", i: number) => `${v}${i}-${stamp}@example.invalid`;
    const sendRows: Record<string, unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      sendRows.push({
        organization_id: orgId, campaign_id: campaignId, contact_id: contactId,
        mailbox_id: mailboxId, step_index: 0, to_email: emailFor("a", i),
        variant_id: "E1", status: "sent",
      });
      sendRows.push({
        organization_id: orgId, campaign_id: campaignId, contact_id: contactId,
        mailbox_id: mailboxId, step_index: 0, to_email: emailFor("b", i),
        variant_id: "VB", status: "sent",
      });
    }
    const { error: sendErr } = await admin.from("native_sends").insert(sendRows);
    if (sendErr) throw new Error(`native_sends insert: ${sendErr.message}`);

    // 3 positive replies to variant A only.
    const replyRows = [0, 1, 2].map((i) => ({
      organization_id: orgId, client_id: clientId, campaign_id: campaignId,
      lead_email: emailFor("a", i), final_class: "true_interest",
      source_channel: "native_email", excluded_from_stats: false,
    }));
    const { error: replyErr } = await admin.from("lead_replies").insert(replyRows);
    if (replyErr) throw new Error(`lead_replies insert: ${replyErr.message}`);

    console.log("\nSeeded draft campaign + mailbox + 10 sends + 3 positive replies (A wins).");

    // ---- Fetch sends + replies from the DB exactly as sync-analytics does ----
    const { data: sends } = await admin
      .from("native_sends")
      .select("variant_id, to_email")
      .eq("campaign_id", campaignId);
    const { data: replies } = await admin
      .from("lead_replies")
      .select("final_class, lead_email")
      .eq("campaign_id", campaignId)
      .eq("source_channel", "native_email")
      .eq("excluded_from_stats", false);
    ok((sends?.length ?? 0) === 10, "10 native_sends rows read back", sends?.length);
    ok((replies?.length ?? 0) === 3, "3 lead_replies rows read back", replies?.length);

    const sendRowsRead = (sends ?? []) as { variant_id: string | null; to_email: string | null }[];
    const replyRowsRead = (replies ?? []) as { final_class: string | null; lead_email: string | null }[];
    const campaignDefault = async () => {
      const { data } = await admin
        .from("campaigns")
        .select("ab_auto_pause_default")
        .eq("id", campaignId)
        .single();
      return (data as { ab_auto_pause_default: boolean }).ab_auto_pause_default;
    };

    // ---- OFF by default: node inherits the campaign default (false) → no pause ----
    ok((await campaignDefault()) === false, "campaign default starts off (column round-trips)");
    const offPass = await evaluateAbWinners(admin, campaignId!, GRAPH, sendRowsRead, replyRowsRead, false);
    ok(offPass === 0, "auto-pause OFF (inherited) → the blowout is NOT paused");

    // ---- Flip the campaign default on (the settings toggle) → node inherits ON ----
    await admin.from("campaigns").update({ ab_auto_pause_default: true }).eq("id", campaignId);
    ok((await campaignDefault()) === true, "campaign default flips on (column round-trips)");
    const paused = await evaluateAbWinners(admin, campaignId!, GRAPH, sendRowsRead, replyRowsRead, true);
    ok(paused === 1, "auto-pause ON (inherited from campaign) → paused exactly one variant", paused);

    // ---- The pause round-trips through campaigns.flow_graph JSONB ----
    const { data: campRead } = await admin
      .from("campaigns")
      .select("flow_graph")
      .eq("id", campaignId)
      .single();
    const storedGraph = (campRead as { flow_graph: FlowGraph }).flow_graph;
    const storedE1 = storedGraph.nodes.find((n) => n.id === "E1") as EmailNode | undefined;
    ok(
      !!storedE1 && (storedE1.paused_variant_ids ?? []).includes("VB"),
      "loser VB is paused in the stored flow_graph",
      storedE1?.paused_variant_ids,
    );
    ok(!(storedE1?.paused_variant_ids ?? []).includes("E1"), "winner A is NOT paused");

    // ---- Sender read-path: new leads route to A; an assigned lead stays sticky ----
    const newAssignments = new Set<string>();
    for (let i = 0; i < 100; i++) newAssignments.add(pickVariant(storedE1!, `newlead_${i}`).id);
    ok(newAssignments.size === 1 && newAssignments.has("E1"), "every NEW lead now routes to A (paused B excluded)", [...newAssignments]);
    ok(pickVariant(storedE1!, "oldlead", { assignedId: "VB" }).id === "VB", "a lead already on B stays on B (sticky, no re-route)");

    // ---- A manual re-save that dropped the pause is preserved server-side ----
    const strippedE1 = emailNode("Subject A {{first_name}}", "Body A for {{company}}.", "E1");
    strippedE1.variants = [emailVariant("Subject B {{first_name}}", "Body B for {{company}}.", "VB")];
    const strippedGraph: FlowGraph = { version: 1, nodes: [strippedE1] }; // no paused_variant_ids
    const preserved = mergeStoredPauses(strippedGraph, storedGraph);
    const preservedE1 = preserved.nodes.find((n) => n.id === "E1") as EmailNode;
    ok((preservedE1.paused_variant_ids ?? []).includes("VB"), "mergeStoredPauses re-applies the pause a manual save dropped");

    // ---- Idempotency: a second pass adds nothing ----
    const again = await evaluateAbWinners(admin, campaignId!, storedGraph, sendRowsRead, replyRowsRead, true);
    ok(again === 0, "second pass is idempotent (already decided → 0 new pauses)", again);
  } finally {
    // ---- Cleanup: delete everything we created ----
    console.log("\nCleaning up…");
    if (campaignId) await admin.from("lead_replies").delete().eq("campaign_id", campaignId);
    if (campaignId) await admin.from("native_sends").delete().eq("campaign_id", campaignId);
    if (contactId) await admin.from("contacts").delete().eq("id", contactId);
    if (campaignId) await admin.from("campaigns").delete().eq("id", campaignId);
    if (mailboxId) await admin.from("native_mailboxes").delete().eq("id", mailboxId);

    if (campaignId) {
      const { count: campLeft } = await admin
        .from("campaigns").select("id", { count: "exact", head: true }).eq("id", campaignId);
      const { count: sendLeft } = await admin
        .from("native_sends").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
      const { count: replyLeft } = await admin
        .from("lead_replies").select("id", { count: "exact", head: true }).eq("campaign_id", campaignId);
      ok((campLeft ?? 0) === 0 && (sendLeft ?? 0) === 0 && (replyLeft ?? 0) === 0, "cleanup removed the campaign + sends + replies");
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E crashed:", e);
  process.exit(1);
});
