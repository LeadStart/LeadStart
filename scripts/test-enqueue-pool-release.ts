#!/usr/bin/env node
/**
 * Drives the REAL enqueueEnrichment (src/lib/apify/enqueue-enrichment.ts) and
 * the REAL drain-enrichment-queue cron against an in-memory database, to prove
 * that a firm released from the weak-email-host pool stays released:
 *   - released (pool-released, the pool tag swapped off the way the
 *     tube-pipeline skill's enrich step and Contacts → Enrich do it): enriched
 *     like a Microsoft 365 / Google firm, never re-tagged pooled-weak-host
 *   - a weak-host firm that was never released: still pooled when its host is
 *     seen here (tag added, detached from its campaign, left out of the run)
 *   - an already-pooled firm: still left out, its queue stamp cleared
 *   - a LinkedIn lead on a weak host: still enriched (never pooled)
 *   - the same holds when the org is busy and the drain cron starts the run
 *     later from the queue stamps
 *
 * Every firm's mail host is stamped on its enrichment_data, so no DNS lookup
 * runs. scripts/tsconfig.client-import-harness.json swaps the Supabase clients
 * for scripts/_stubs/fake-supabase.ts. No network, no database: nothing here
 * can reach the live project.
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.client-import-harness.json scripts/test-enqueue-pool-release.ts
 */
import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { POOL_TAG, POOL_RELEASED_TAG, isPooled, withPoolReleased } from "../src/lib/enrichment/pool.ts";
import { fakeState, resetFake } from "./_stubs/fake-supabase.ts";

// If the module swap ever failed, a real client would get an unreachable URL
// and no service key, so it could not reach the live project either.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "harness";
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.CRON_SECRET = "harness-cron-secret";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq<T>(got: T, want: T, msg: string) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg} (got ${g}, want ${w})`);
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const ORG = "org-harness";
const OWNER_ID = "user-owner";
const CAMPAIGN = "camp-tube";
const QUEUED_AT = "2026-10-01T00:00:00.000Z";

function mailHost(host: string): Row {
  return { mail_host: { host, mx: host === "none" ? null : `mx.${host}.test`, checked_at: QUEUED_AT } };
}

// A Google-Maps firm: company + website, no person, no email, no LinkedIn.
function firm(id: string, host: string, tags: string[], over: Row = {}): Row {
  return {
    id,
    organization_id: ORG,
    first_name: null,
    last_name: null,
    email: null,
    company_name: `Firm ${id}`,
    linkedin_url: null,
    company_linkedin_url: null,
    company_domain: `${id}.test`,
    enrichment_data: mailHost(host),
    tags,
    campaign_id: null,
    enrich_queued_at: null,
    ...over,
  };
}

function fixtures(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    contacts: [
      firm("strong", "microsoft365", ["maps", "prospecting"], { campaign_id: CAMPAIGN }),
      // Weak host seen only now (no pool tag yet): pooled here, as before.
      firm("weak-new", "godaddy", ["maps", "prospecting"], { campaign_id: CAMPAIGN }),
      // Pooled at import, then released the way enrich.mts (weak_hosts: "enrich") does.
      firm("released", "gateway", withPoolReleased(["maps", "prospecting", POOL_TAG])),
      firm("pooled", "other", ["maps", "prospecting", POOL_TAG], { enrich_queued_at: QUEUED_AT }),
      firm("linkedin-weak", "godaddy", ["linkedin"], { linkedin_url: "https://www.linkedin.com/in/jane-harness" }),
    ],
    profiles: [{ id: OWNER_ID, organization_id: ORG, role: "owner" }],
    enrichment_runs: [],
    enrichment_run_items: [],
    ...extra,
  };
}
const ALL_IDS = ["strong", "weak-new", "released", "pooled", "linkedin-weak"];

const contact = (id: string) => fakeState().tables.contacts.find((c) => c.id === id) as Row;
const tagsOf = (id: string) => (contact(id).tags as string[]) ?? [];
function itemContactIds(runId: string): string[] {
  return (fakeState().tables.enrichment_run_items ?? [])
    .filter((i) => i.run_id === runId)
    .map((i) => String(i.contact_id))
    .sort();
}

// ── Scenarios ───────────────────────────────────────────────────────────────

type EnqueueFn = typeof import("../src/lib/apify/enqueue-enrichment.ts").enqueueEnrichment;
type DrainGet = (req: NextRequest) => Promise<Response>;

async function main() {
  if ((createAdminClient() as unknown as { __fake?: boolean }).__fake !== true) {
    throw new Error("The Supabase module swap did not take: run with --tsconfig scripts/tsconfig.client-import-harness.json");
  }
  const { enqueueEnrichment } = (await import("../src/lib/apify/enqueue-enrichment.ts")) as { enqueueEnrichment: EnqueueFn };
  const { GET: drain } = (await import("../src/app/api/cron/drain-enrichment-queue/route.ts")) as unknown as { GET: DrainGet };
  const admin = createAdminClient();
  const tick = () =>
    drain(
      new NextRequest("http://localhost/app/api/cron/drain-enrichment-queue", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      }),
    ).then((r) => r.json() as Promise<Row>);

  console.log("\n1. Org free: the skill's enrich step releases the pool, then enqueues every firm");
  resetFake(fixtures(), null);
  const r1 = await enqueueEnrichment(admin, { organizationId: ORG, userId: OWNER_ID, contactIds: ALL_IDS });
  eq(r1.status, "started", "a run starts");
  const run1 = r1.status === "started" ? r1.runId : "";
  eq(r1.status === "started" ? r1.total : null, 3, "total: strong, released, linkedin-weak");
  eq(r1.status === "started" ? r1.pooled : null, 2, "pooled: weak-new (now) + pooled (already)");
  eq(itemContactIds(run1), ["linkedin-weak", "released", "strong"], "run items: the released firm is in the run");
  eq(isPooled(tagsOf("released")), false, "released: not re-tagged pooled-weak-host");
  eq(tagsOf("released"), ["maps", "prospecting", POOL_RELEASED_TAG], "released: tags unchanged");
  eq(isPooled(tagsOf("weak-new")), true, "weak-new (never released): pooled as before");
  eq(contact("weak-new").campaign_id, null, "weak-new: detached from its campaign");
  eq(contact("strong").campaign_id, CAMPAIGN, "strong: keeps its campaign");
  eq(contact("pooled").enrich_queued_at, null, "pooled: queue stamp cleared");
  eq(isPooled(tagsOf("linkedin-weak")), false, "linkedin-weak: a LinkedIn lead is never pooled");

  console.log("\n2. Org busy: the firms are queued, and the drain cron starts the run later");
  resetFake(fixtures({ enrichment_runs: [{ id: "run-busy", organization_id: ORG, status: "running" }] }), null);
  const r2 = await enqueueEnrichment(admin, { organizationId: ORG, userId: OWNER_ID, contactIds: ALL_IDS });
  eq(r2.status, "queued", "queued behind the active run");
  eq(r2.status === "queued" ? r2.count : null, 4, "queued: strong, weak-new, released, linkedin-weak");
  eq(contact("released").enrich_queued_at != null, true, "released: stamped for the drain");
  eq((await tick()).status, "org_busy", "drain tick while the run is active: org_busy");
  (fakeState().tables.enrichment_runs.find((r) => r.id === "run-busy") as Row).status = "complete";
  const d = await tick();
  eq(d.status, "drained", "drain tick after the run finishes: drained");
  const r3 = d.result as { status: string; runId?: string; total?: number; pooled?: number };
  eq(r3.status, "started", "the drain starts a run");
  eq(r3.total, 3, "drain run total: strong, released, linkedin-weak");
  eq(r3.pooled, 1, "drain run pooled: weak-new");
  eq(itemContactIds(r3.runId ?? ""), ["linkedin-weak", "released", "strong"], "drain run items: the released firm is in the run");
  eq(isPooled(tagsOf("released")), false, "released: still not pooled after the drain");
  eq(contact("released").enrich_queued_at, null, "released: queue stamp cleared once enrolled");
  eq(isPooled(tagsOf("weak-new")), true, "weak-new: pooled by the drain run");
  eq(contact("weak-new").enrich_queued_at, null, "weak-new: queue stamp cleared");
  eq((await tick()).status, "idle", "next drain tick: idle (nothing left queued)");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
