import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalBad, isTerminalOk } from "@/lib/apify/types";
import { loadApifyToken, normalizeEnrichmentSettings } from "@/lib/apify/auth";
import { extractCompanyId, extractCompanySlug } from "@/lib/apify/domain";
import {
  getProvider,
  WATERFALL_BOVI_ACTOR_ID,
  WATERFALL_SCRAPE_ACTOR_ID,
} from "@/lib/apify/providers";
import type { PhaseResult, ProviderItem } from "@/lib/apify/providers/types";
import { sanitizeFoundEmail } from "@/lib/apify/email-sanity";
import { ENRICH_RUN_COLUMNS, ENRICH_ITEM_WORK_COLUMNS } from "@/lib/apify/columns";
import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  WATERFALL_LEAD_COST_USD,
  ACTIVITY_COST_USD,
  MV_CREDIT_COST_USD,
} from "@/lib/apify/pricing";
import {
  DEFAULT_ENRICHMENT_SETTINGS,
  type EmailProviderId,
  type EmailVerificationStatus,
  type EnrichmentPhase,
  type EnrichmentSettings,
  type EnrichmentWaterfallMethod,
} from "@/types/app";
import { alertActorFailure } from "@/lib/notifications/actor-failure-alert";
import { MillionVerifierClient, MillionVerifierError } from "@/lib/millionverifier/client";
import type { MillionVerifierResponse } from "@/lib/millionverifier/client";
import {
  decideFromCached,
  decideFromResult,
  ORG_ERROR_SUPPRESS_MS,
  shouldAlertAccountError,
} from "@/lib/millionverifier/policy";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import { runPatternMv, type PatternMvItem } from "@/lib/enrichment/pattern-mv";
import { hasUsableName, methodForItem } from "@/lib/enrichment/waterfall-routing";
import { classifyContactOutcome, addOutcome, ALL_COUNT_KEYS } from "@/lib/enrichment/outcomes";
import Anthropic from "@anthropic-ai/sdk";
import { callPerplexity } from "@/lib/perplexity/client";
import { calculateCost, HAIKU_MODEL_ID } from "@/lib/decision-maker/pricing";
import { fetchPage } from "@/lib/decision-maker/fetcher";
import { isSafeUrl } from "@/lib/decision-maker/validation";
import { enrichBusiness, type EnrichmentInput, type EnrichmentResult } from "@/lib/decision-maker";
import {
  runDomainDiscovery,
  extractContactLocation,
  type DiscoveryItem,
  type LlmSearchFn,
} from "@/lib/enrichment/domain-discovery";

// GET /api/cron/run-apify-enrichment — one worker tick (60s budget).
//
// Drives the four-phase Apify pipeline (profiles → domains → waterfall →
// activity). Email verification is NOT a phase here — Million Verifier owns it
// (its own pre-send gate); this worker only fills contacts.email (fill-only) +
// provenance. Deliberate deviation from the decision-maker worker: a 90s
// `locked_at` lease on the claim, because each tick makes PAID external calls
// and the DM-style claim alone lets two ticks proceed once a run is 'running'.

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;
const LEASE_MS = 90_000;
const STUCK_AFTER_MS = 20 * 60_000;
const APIFY_TIMEOUT_SEC = 1200;
const MAX_ITEM_ATTEMPTS = 2;
const MAX_CONSECUTIVE_FAILURES = 3;
const START_BUDGET_SEC = 45;

// pattern_mv (direct method) tuning. A small MV pool + wall-clock deadline keeps
// a batch inside the 60s tick; leftover items stay pending for the next tick.
const PATTERN_MV_BATCH = 25;
const PATTERN_MV_CONCURRENCY = 5;
const PATTERN_MV_VERIFY_TIMEOUT_SEC = 6;
const PATTERN_MV_DEADLINE_SEC = 40;

// Domain-discovery (inline web lookup for companies with no LinkedIn page).
// Smaller batch + pool than pattern_mv — each item is an LLM web search (slower)
// plus an optional homepage fetch.
const DISCOVERY_BATCH = 10;
const DISCOVERY_CONCURRENCY = 3;
const DISCOVERY_DEADLINE_SEC = 40;

// Naming (inline decision-maker Layer 1/2). The heaviest inline step — each item
// scrapes a site (Layer 1) and may web-search (Layer 2) — so small batch + pool
// + a per-business timeout well under the tick budget.
const NAMING_BATCH = 4;
const NAMING_CONCURRENCY = 2;
const NAMING_DEADLINE_SEC = 45;
const NAMING_PER_BUSINESS_TIMEOUT_MS = 30_000;

// Waterfall methods by execution style:
//   DIRECT   — run inline in the tick via Million Verifier, no Apify run.
//   SCRAPE   — our site-contact-scraper actor (site_scrape + the scrape stage of
//              scrape_plus_pattern, which then hands misses to pattern_mv).
//   APIFY_SOLO — the single-actor community scraper (bovi).
// All Apify styles use the existing start-run → poll → ingest path.
const DIRECT_METHODS: EnrichmentWaterfallMethod[] = ["pattern_mv"];
const SCRAPE_METHODS: EnrichmentWaterfallMethod[] = ["site_scrape", "scrape_plus_pattern"];
const APIFY_SOLO_METHODS: EnrichmentWaterfallMethod[] = ["bovi"];

function actorForMethod(method: EnrichmentWaterfallMethod): string | null {
  if (method === "bovi") return WATERFALL_BOVI_ACTOR_ID;
  if (method === "site_scrape" || method === "scrape_plus_pattern") return WATERFALL_SCRAPE_ACTOR_ID;
  return null;
}

type Admin = SupabaseClient;

interface RunRow {
  id: string;
  organization_id: string;
  phase: EnrichmentPhase;
  status: string;
  run_profiles: boolean;
  run_domains: boolean;
  run_waterfall: boolean;
  run_activity: boolean;
  // Opt-in Million Verifier phase (migration 00077).
  run_verify: boolean;
  // Opt-in decision-maker naming phase (migration 00079).
  run_naming: boolean;
  profile_actor: string;
  domain_actor: string;
  waterfall_actor: string | null;
  // Enrichment-settings snapshot at run start (migration 00075); null on runs
  // created before the waterfall-settings feature.
  waterfall_config: EnrichmentSettings | null;
  active_apify_run_id: string | null;
  active_apify_dataset_id: string | null;
  active_batch_started_at: string | null;
  active_batch_attempt: number;
  consecutive_failures: number;
  cost_usd: number | string;
  started_at: string | null;
  total_count: number;
}

type ItemRow = ProviderItem & {
  contact_id: string;
  attempts: number;
  waterfall_method: EnrichmentWaterfallMethod | null;
  profile_status: string;
  profile_apify_run_id: string | null;
  domain_status: string;
  domain_apify_run_id: string | null;
  naming_status: string | null;
  waterfall_status: string | null;
  waterfall_apify_run_id: string | null;
};

const PHASE_COLS: Record<
  Exclude<EnrichmentPhase, "complete">,
  { status: string; runId: string; notes: string }
> = {
  profiles: { status: "profile_status", runId: "profile_apify_run_id", notes: "profile_notes" },
  domains: { status: "domain_status", runId: "domain_apify_run_id", notes: "domain_notes" },
  // Naming is inline (decision-maker Layer 1/2, no Apify run) — runId is never
  // queried; runPhase short-circuits before the Apify path, like verify.
  naming: { status: "naming_status", runId: "naming_apify_run_id", notes: "naming_notes" },
  waterfall: { status: "waterfall_status", runId: "waterfall_apify_run_id", notes: "waterfall_notes" },
  activity: { status: "activity_status", runId: "activity_apify_run_id", notes: "activity_notes" },
  // Verify is inline (Million Verifier, no Apify run) — runId is never queried
  // for it; runPhase short-circuits before the Apify start/poll path.
  verify: { status: "verify_status", runId: "verify_apify_run_id", notes: "verify_notes" },
};

// pattern_mv + verify are inline Million Verifier phases: batch, small pool, and
// a wall-clock deadline that keeps a tick under the 60s budget.
const VERIFY_BATCH = 25;
const VERIFY_CONCURRENCY = 5;
const VERIFY_TIMEOUT = 6; // MV server-side timeout param (sec)
const VERIFY_DEADLINE_SEC = 40;

function estimatePerItem(phase: EnrichmentPhase): number {
  switch (phase) {
    case "profiles": return PROFILE_EMAIL_COST_USD;
    case "domains": return DOMAIN_COST_USD;
    case "waterfall": return WATERFALL_LEAD_COST_USD;
    case "activity": return ACTIVITY_COST_USD;
    case "verify": return MV_CREDIT_COST_USD;
    default: return 0;
  }
}

// Add a failed/aborted run's real Apify charge to the enrichment run total.
// Pay-per-event billing charges as events happen, so a run that never SUCCEEDED
// still cost money; only the success path recorded it before, which silently
// hid the spend (e.g. an aborted vdrmota waterfall). No estimate fallback here —
// a run that didn't finish has no item count to estimate from; record only what
// Apify actually reports.
async function recordBadRunCost(
  admin: Admin,
  run: RunRow,
  apRun: { usageTotalUsd?: number | null },
): Promise<void> {
  const usd = typeof apRun.usageTotalUsd === "number" ? apRun.usageTotalUsd : 0;
  if (usd <= 0) return;
  const next = (Number(run.cost_usd) || 0) + usd;
  await admin.from("enrichment_runs").update({ cost_usd: next }).eq("id", run.id);
  run.cost_usd = next;
}

function mergeEnrichment(ed: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = ed && typeof ed === "object" ? { ...(ed as Record<string, unknown>) } : {};
  const enr =
    base.enrichment && typeof base.enrichment === "object"
      ? { ...(base.enrichment as Record<string, unknown>) }
      : {};
  Object.assign(enr, patch);
  base.enrichment = enr;
  return base;
}

// ---------------------------------------------------------------- main tick

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const tickStart = Date.now();

  // 1. Oldest active, non-locked (or lease-expired) run.
  const leaseCutoff = new Date(Date.now() - LEASE_MS).toISOString();
  const { data: candidates } = await admin
    .from("enrichment_runs")
    .select(ENRICH_RUN_COLUMNS)
    .in("status", ["pending", "running"])
    .or(`locked_at.is.null,locked_at.lt.${leaseCutoff}`)
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ status: "idle" });
  }
  const candidate = candidates[0] as unknown as RunRow;

  // 2. Lease claim — only one tick may hold a run at a time.
  const { data: claimed } = await admin
    .from("enrichment_runs")
    .update({ status: "running", started_at: candidate.started_at ?? nowIso, locked_at: nowIso })
    .eq("id", candidate.id)
    .in("status", ["pending", "running"])
    .or(`locked_at.is.null,locked_at.lt.${leaseCutoff}`)
    .select(ENRICH_RUN_COLUMNS);

  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ status: "claim_failed", id: candidate.id });
  }
  const run = claimed[0] as unknown as RunRow;

  // 3. Token (every phase is an Apify actor).
  const token = await loadApifyToken(admin, run.organization_id);
  if (!token) {
    await failRun(admin, run.id, "Apify API token not set (org key + APIFY_API_TOKEN both empty)");
    return NextResponse.json({ status: "failed", id: run.id, error: "no_apify_key" });
  }
  const client = new ApifyClient(token);

  // 4. Dispatch on phase.
  let result: Record<string, unknown>;
  try {
    if (run.phase === "complete") {
      result = { status: "complete" };
    } else {
      result = await runPhase(admin, client, run, tickStart);
    }
    await admin.from("enrichment_runs").update({ consecutive_failures: 0 }).eq("id", run.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cron/run-apify-enrichment] run ${run.id} phase ${run.phase} threw:`, err);
    const failures = (run.consecutive_failures ?? 0) + 1;
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await failRun(admin, run.id, `Too many consecutive failures: ${message}`);
      return NextResponse.json({ status: "failed", id: run.id, error: message });
    }
    await admin
      .from("enrichment_runs")
      .update({
        consecutive_failures: failures,
        progress_message: `Retrying after error: ${message.slice(0, 200)}`,
        locked_at: null,
      })
      .eq("id", run.id);
    return NextResponse.json({ status: "error", id: run.id, error: message });
  }

  // 5. Recompute counters + release the lease.
  const counts = await recomputeCounters(admin, run);
  return NextResponse.json({ status: (result.status as string) ?? "ok", id: run.id, phase: run.phase, ...result, ...counts });
}

// ---------------------------------------------------------------- phase driver

async function runPhase(
  admin: Admin,
  client: ApifyClient,
  run: RunRow,
  tickStart: number,
): Promise<Record<string, unknown>> {
  const phase = run.phase as Exclude<EnrichmentPhase, "complete">;
  const cols = PHASE_COLS[phase];

  // Verify is an inline Million Verifier phase (no Apify run) — handle it before
  // the provider lookup / Apify start-poll path, same as pattern_mv inside the
  // waterfall.
  if (phase === "verify") {
    return runVerifyPhase(admin, client, run, tickStart);
  }
  // Naming is an inline decision-maker phase (no Apify run) — same pattern.
  if (phase === "naming") {
    return runNamingBatch(admin, client, run, tickStart);
  }

  const provider = getProvider(phase, run.waterfall_actor);
  if (!provider) {
    await advancePhase(admin, client, run);
    return { status: "advanced", note: "no provider for phase" };
  }

  // --- A. an Apify run is already in flight for this phase ---
  if (run.active_apify_run_id) {
    const apRun = await client.getRun(run.active_apify_run_id);

    if (isInProgress(apRun.status)) {
      const startedMs = run.active_batch_started_at ? Date.parse(run.active_batch_started_at) : Date.now();
      if (Date.now() - startedMs > STUCK_AFTER_MS) {
        try {
          await client.abortRun(run.active_apify_run_id);
        } catch {
          /* best-effort */
        }
        // Apify bills per event as it runs, so a stuck+aborted run still cost
        // money — record whatever it accrued (partial) so spend isn't hidden.
        await recordBadRunCost(admin, run, apRun);
        await requeueOrFail(admin, run, cols, "stuck >20min; aborted");
        await clearActive(admin, run.id);
        return { status: "batch_failed", apify_status: apRun.status, note: "stuck" };
      }
      await admin
        .from("enrichment_runs")
        .update({
          progress_message: `Waiting on Apify (${phase}) run ${run.active_apify_run_id} — ${apRun.status}`,
          locked_at: null,
        })
        .eq("id", run.id);
      return { status: "waiting", apify_run_id: run.active_apify_run_id, apify_status: apRun.status };
    }

    if (isTerminalOk(apRun.status)) {
      const datasetId = run.active_apify_dataset_id ?? apRun.defaultDatasetId;
      const items = await client.getAllDatasetItems(datasetId);
      const inFlight = await fetchInFlight(admin, run.id, cols.status);
      const harvested = await ingest(admin, run, phase, provider, inFlight, items);
      const actualCost = typeof apRun.usageTotalUsd === "number" ? apRun.usageTotalUsd : null;
      const batchCost = actualCost ?? inFlight.length * estimatePerItem(phase);
      await admin
        .from("enrichment_runs")
        .update({ cost_usd: (Number(run.cost_usd) || 0) + batchCost })
        .eq("id", run.id);
      run.cost_usd = (Number(run.cost_usd) || 0) + batchCost;
      // Per-method result line for the run banner (pattern_mv sets its own).
      if (phase === "waterfall") {
        const h = harvested as { found: number; not_found: number; skipped: number };
        const label = waterfallMethodLabel(run.waterfall_actor);
        await admin
          .from("enrichment_runs")
          .update({
            progress_message: `${label}: ${h.found} found · ${h.not_found} miss${h.skipped ? ` · ${h.skipped} deferred` : ""}`,
          })
          .eq("id", run.id);
      }
      await clearActive(admin, run.id);
      run.active_apify_run_id = null;

      // Time permitting, immediately start the next batch this same tick.
      if ((Date.now() - tickStart) / 1000 < 30) {
        const next = await startNextBatch(admin, client, run, phase, cols, provider, tickStart);
        return { status: "harvested", harvested, next: next.status };
      }
      return { status: "harvested", harvested };
    }

    if (isTerminalBad(apRun.status)) {
      // A FAILED/TIMED-OUT/ABORTED run still incurred its per-event charges —
      // record the real cost (usageTotalUsd is final here) before requeueing,
      // or the spend disappears from the run total.
      await recordBadRunCost(admin, run, apRun);
      await requeueOrFail(admin, run, cols, `Apify run ${apRun.status}: ${apRun.statusMessage ?? ""}`);
      await clearActive(admin, run.id);
      const failures = (run.consecutive_failures ?? 0) + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        await failRun(admin, run.id, `Apify batch failed ${MAX_CONSECUTIVE_FAILURES}x (${apRun.status})`);
        return { status: "failed", apify_status: apRun.status };
      }
      await admin.from("enrichment_runs").update({ consecutive_failures: failures }).eq("id", run.id);
      return { status: "batch_failed", apify_status: apRun.status };
    }
  }

  // --- B. no active run: recover orphans, then start the next batch ---
  await recoverOrphans(admin, run, cols);
  return startNextBatch(admin, client, run, phase, cols, provider, tickStart);
}

// ---------------------------------------------------------------- start a batch

async function startNextBatch(
  admin: Admin,
  client: ApifyClient,
  run: RunRow,
  phase: Exclude<EnrichmentPhase, "complete">,
  cols: { status: string; runId: string; notes: string },
  provider: ReturnType<typeof getProvider>,
  tickStart: number,
  // When set (an internal apify-waterfall sub-batch), scope the pending select
  // to one method group and do NOT advance the phase on an empty batch — the
  // waterfall router owns advancing. Absent = a normal phase batch.
  methodFilter?: EnrichmentWaterfallMethod[],
  // When set (the domains linkedin-company sub-batch), scope the pending select
  // to items WITH a company ref and do NOT advance on empty — the domains router
  // owns advancing (it also runs the inline web-lookup discovery sub-stage).
  domainsRefsOnly?: boolean,
): Promise<Record<string, unknown>> {
  // The waterfall phase has per-item methods (incl. the direct pattern_mv
  // pathway), so it's routed specially — unless we're already inside a
  // method-scoped apify sub-batch call.
  if (phase === "waterfall" && !methodFilter) {
    return startNextWaterfall(admin, client, run, cols, tickStart);
  }
  // The domains phase is two-stage (linkedin-company Apify batch for items with a
  // company ref, then inline web-lookup discovery for name-only items).
  if (phase === "domains" && !domainsRefsOnly) {
    return startNextDomains(admin, client, run, cols, provider, tickStart);
  }
  if (!provider) return { status: "advanced" };

  const batchSize = BATCH_SIZE;
  let pendingQuery = admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", run.id)
    .eq(cols.status, "pending");
  if (methodFilter) pendingQuery = pendingQuery.in("waterfall_method", methodFilter);
  // Scope to items that actually carry a LinkedIn company ref — a mixed batch
  // would feed ref-less items into the company actor, which returns nothing for
  // them and marks them not_found before discovery ever gets a chance.
  if (domainsRefsOnly) pendingQuery = pendingQuery.or("company_id.not.is.null,company_slug.not.is.null");
  const { data: pendingData } = await pendingQuery
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(batchSize);

  let batch = (pendingData as ItemRow[] | null) ?? [];
  if (batch.length === 0) {
    if (methodFilter || domainsRefsOnly) return { status: "skipped_batch" };
    await advancePhase(admin, client, run);
    return { status: "advanced", phase: run.phase };
  }

  // Re-check the contacts — someone may have filled the target field since the
  // run was created / a prior phase ran.
  batch = await dropAlreadyDone(admin, run, phase, cols, batch);
  if (batch.length === 0) {
    return { status: "skipped_batch" };
  }

  const input = provider.buildInput(batch, run.waterfall_config ?? null);
  if (isEmptyInput(input)) {
    // Nothing actionable in this batch (e.g. all lacked a domain) — mark
    // not_found so the run can progress.
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "not_found", [cols.notes]: "no usable input for this step" })
      .eq("run_id", run.id)
      .in("id", batch.map((b) => b.id));
    return { status: "skipped_batch", note: "empty input" };
  }

  const elapsedSec = (Date.now() - tickStart) / 1000;
  const waitSec = Math.max(0, Math.min(20, START_BUDGET_SEC - elapsedSec));

  // Call Apify FIRST. A throw here leaves items 'pending' (nothing marked) and
  // is caught by the tick's try/catch — the only crash window is between this
  // POST and the item update, which at worst orphans one paid run (no data
  // corruption), and the lease prevents a concurrent second start.
  const apRun = await client.startActorRun(provider.actorId, input, {
    waitForFinishSec: waitSec,
    timeoutSec: APIFY_TIMEOUT_SEC,
  });

  // Mark the batch in-flight with this run id.
  await admin
    .from("enrichment_run_items")
    .update({ [cols.status]: "in_flight", [cols.runId]: apRun.id })
    .eq("run_id", run.id)
    .eq(cols.status, "pending")
    .in("id", batch.map((b) => b.id));

  // Claim the active slot on the run (guarded so a racing tick can't double-set).
  const { data: setActive } = await admin
    .from("enrichment_runs")
    .update({
      active_apify_run_id: apRun.id,
      active_apify_dataset_id: apRun.defaultDatasetId,
      active_batch_started_at: new Date().toISOString(),
      active_batch_attempt: (run.active_batch_attempt ?? 0) + 1,
      progress_message: `Started ${phase} batch of ${batch.length} (Apify ${apRun.id})`,
      locked_at: null,
    })
    .eq("id", run.id)
    .is("active_apify_run_id", null)
    .select("id");

  if (!setActive || setActive.length === 0) {
    // Shouldn't happen under the lease; don't leave a paid run dangling.
    try {
      await client.abortRun(apRun.id);
    } catch {
      /* best-effort */
    }
    throw new Error("Failed to claim active Apify run slot (race)");
  }
  run.active_apify_run_id = apRun.id;
  run.active_apify_dataset_id = apRun.defaultDatasetId;

  // If it already finished within waitForFinish and we have budget, ingest now.
  if (isTerminalOk(apRun.status) && (Date.now() - tickStart) / 1000 < 35) {
    const items = await client.getAllDatasetItems(apRun.defaultDatasetId);
    const inFlight = await fetchInFlight(admin, run.id, cols.status);
    const harvested = await ingest(admin, run, phase, provider, inFlight, items);
    const actualCost = typeof apRun.usageTotalUsd === "number" ? apRun.usageTotalUsd : null;
    const batchCost = actualCost ?? inFlight.length * estimatePerItem(phase);
    await admin
      .from("enrichment_runs")
      .update({ cost_usd: (Number(run.cost_usd) || 0) + batchCost })
      .eq("id", run.id);
    await clearActive(admin, run.id);
    return { status: "harvested", harvested, note: "sync" };
  }

  return { status: "started", apify_run_id: apRun.id, items: batch.length };
}

function isEmptyInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return true;
  const obj = input as Record<string, unknown>;
  const arrays = [obj.urls, obj.companies, obj.people, obj.emails, obj.startUrls, obj.targets];
  const anyNonEmpty = arrays.some((a) => Array.isArray(a) && a.length > 0);
  return !anyNonEmpty;
}

// -------------------------------------------------------- waterfall routing

// Count pending waterfall items whose method is in `methods`.
async function countWaterfallMethodPending(
  admin: Admin,
  runId: string,
  methods: EnrichmentWaterfallMethod[],
): Promise<number> {
  const { count } = await admin
    .from("enrichment_run_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("waterfall_status", "pending")
    .in("waterfall_method", methods);
  return count ?? 0;
}

// The waterfall phase, method-routed: process the direct (pattern_mv) group
// inline first, then each configured Apify method in a fixed order (one active
// Apify run at a time). When nothing is pending across all methods, advance.
async function startNextWaterfall(
  admin: Admin,
  client: ApifyClient,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
  tickStart: number,
): Promise<Record<string, unknown>> {
  // 1. Direct pattern_mv group (cheap, no external run) — also picks up
  //    scrape_plus_pattern items downgraded to pattern_mv after a scrape miss.
  if ((await countWaterfallMethodPending(admin, run.id, DIRECT_METHODS)) > 0) {
    return runPatternMvBatch(admin, run, cols, tickStart);
  }
  // 2. Our site-scraper group (site_scrape + scrape_plus_pattern's scrape stage).
  if ((await countWaterfallMethodPending(admin, run.id, SCRAPE_METHODS)) > 0) {
    const actorId = actorForMethod("site_scrape");
    run.waterfall_actor = actorId;
    await admin.from("enrichment_runs").update({ waterfall_actor: actorId }).eq("id", run.id);
    const provider = getProvider("waterfall", actorId);
    return startNextBatch(admin, client, run, "waterfall", cols, provider, tickStart, SCRAPE_METHODS);
  }
  // 3. Single-actor community scraper (bovi).
  for (const method of APIFY_SOLO_METHODS) {
    if ((await countWaterfallMethodPending(admin, run.id, [method])) > 0) {
      const actorId = actorForMethod(method);
      run.waterfall_actor = actorId;
      await admin.from("enrichment_runs").update({ waterfall_actor: actorId }).eq("id", run.id);
      const provider = getProvider("waterfall", actorId);
      return startNextBatch(admin, client, run, "waterfall", cols, provider, tickStart, [method]);
    }
  }
  await advancePhase(admin, client, run);
  return { status: "advanced", phase: run.phase };
}

// Count pending domain items with (or without) a parseable LinkedIn company ref.
async function countDomainsPending(admin: Admin, runId: string, withRefs: boolean): Promise<number> {
  let q = admin
    .from("enrichment_run_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq("domain_status", "pending");
  q = withRefs
    ? q.or("company_id.not.is.null,company_slug.not.is.null")
    : q.is("company_id", null).is("company_slug", null).not("company_name", "is", null);
  const { count } = await q;
  return count ?? 0;
}

// The domains phase, two-stage (mirrors startNextWaterfall): resolve domains for
// items WITH a LinkedIn company ref via the harvestapi company actor first, then
// discover domains for name-only (no-ref) items via an inline web lookup, then
// advance. One active Apify run at a time.
async function startNextDomains(
  admin: Admin,
  client: ApifyClient,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
  provider: ReturnType<typeof getProvider>,
  tickStart: number,
): Promise<Record<string, unknown>> {
  // 1. Items with a company ref → the harvestapi linkedin-company Apify batch.
  if ((await countDomainsPending(admin, run.id, true)) > 0) {
    return startNextBatch(admin, client, run, "domains", cols, provider, tickStart, undefined, true);
  }
  // 2. Name-only items (no LinkedIn company page) → inline web-lookup discovery.
  if ((await countDomainsPending(admin, run.id, false)) > 0) {
    return runDomainDiscoveryBatch(admin, run, cols, tickStart);
  }
  // 3. Any remaining pending (ref-less AND nameless — shouldn't happen) can't be
  //    resolved either way; mark them so they don't strand the phase, then advance.
  await admin
    .from("enrichment_run_items")
    .update({ domain_status: "not_found", domain_notes: "no company reference or name to resolve a domain" })
    .eq("run_id", run.id)
    .eq("domain_status", "pending");
  await advancePhase(admin, client, run);
  return { status: "advanced", phase: run.phase };
}

// Definitive Million Verifier failure during pattern_mv: record it on the org so
// BOTH the enrichment worker and the send-gate back off for the suppression
// window, and fire the same edge-triggered owner alert the send-gate would.
async function recordMvDefinitiveError(
  admin: Admin,
  organizationId: string,
  prevStreak: number,
  err: MillionVerifierError,
): Promise<void> {
  const streak = (prevStreak ?? 0) + 1;
  await admin
    .from("organizations")
    .update({
      millionverifier_last_error: err.message,
      millionverifier_last_error_kind: err.kind,
      millionverifier_last_error_at: new Date().toISOString(),
      millionverifier_error_streak: streak,
    })
    .eq("id", organizationId);
  if (shouldAlertAccountError(err.kind, streak)) {
    await enqueueOwnerAlert({
      admin,
      kind: "email_verifier_unavailable",
      subject: "Email verifier unavailable — enrichment waterfall on hold",
      summary:
        err.kind === "credits"
          ? "Million Verifier is out of credits. Pattern-based email enrichment is held until it's topped up."
          : err.kind === "auth"
            ? "Million Verifier rejected the API key. Pattern-based email enrichment is held until the key is fixed."
            : "This server's IP is blocked by Million Verifier. Pattern-based email enrichment is held.",
      context: { organization_id: organizationId, error_kind: err.kind, error: err.message, streak },
    });
  }
}

// Process one pattern_mv batch inline (no Apify run). Fail-closed on a definitive
// MV error (records suppression, holds the batch); leaves indeterminate items
// pending to retry; writes clean hits fill-only via writeEmail.
async function runPatternMvBatch(
  admin: Admin,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
  tickStart: number,
): Promise<Record<string, unknown>> {
  // Org MV key + error/suppression state.
  const { data: orgRow } = await admin
    .from("organizations")
    .select(
      "millionverifier_api_key, millionverifier_last_error_kind, millionverifier_last_error_at, millionverifier_error_streak",
    )
    .eq("id", run.organization_id)
    .maybeSingle();
  const org = orgRow as {
    millionverifier_api_key: string | null;
    millionverifier_last_error_kind: string | null;
    millionverifier_last_error_at: string | null;
    millionverifier_error_streak: number | null;
  } | null;
  const key = org?.millionverifier_api_key?.trim() || process.env.MILLIONVERIFIER_API_KEY?.trim() || null;

  // Claim a batch of pending direct-method items.
  const { data: pendingData } = await admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", run.id)
    .eq("waterfall_status", "pending")
    .in("waterfall_method", DIRECT_METHODS)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PATTERN_MV_BATCH);
  let batch = (pendingData as ItemRow[] | null) ?? [];
  if (batch.length === 0) return { status: "skipped_batch" };
  batch = await dropAlreadyDone(admin, run, "waterfall", cols, batch);
  if (batch.length === 0) return { status: "skipped_batch" };

  // No MV key → pattern matching can't run. Mark this batch not_found with a
  // clear note (a config gap, not a silent miss) and let the run continue.
  if (!key) {
    await admin
      .from("enrichment_run_items")
      .update({
        waterfall_status: "not_found",
        waterfall_notes: "Million Verifier key required for pattern email finding (Settings → Integrations)",
      })
      .eq("run_id", run.id)
      .in("id", batch.map((b) => b.id));
    return { status: "no_mv_key", items: batch.length };
  }

  // Suppression window after a recent definitive error — hold, don't call MV.
  const kind = org?.millionverifier_last_error_kind;
  const definitive = !!kind && kind !== "transient";
  if (definitive && org?.millionverifier_last_error_at) {
    const at = Date.parse(org.millionverifier_last_error_at);
    if (!Number.isNaN(at) && Date.now() < at + ORG_ERROR_SUPPRESS_MS) {
      await admin
        .from("enrichment_runs")
        .update({ progress_message: "Waterfall held — email verifier unavailable (retrying shortly)", locked_at: null })
        .eq("id", run.id);
      return { status: "mv_suppressed" };
    }
  }

  const config = run.waterfall_config ?? DEFAULT_ENRICHMENT_SETTINGS;
  const client = new MillionVerifierClient(key);
  const deadlineMs = tickStart + PATTERN_MV_DEADLINE_SEC * 1000;
  const mvItems: PatternMvItem[] = batch.map((b) => ({
    id: b.id,
    first_name: b.first_name,
    last_name: b.last_name,
    company_domain: b.company_domain,
  }));

  let outcomes;
  try {
    outcomes = await runPatternMv(client, mvItems, {
      acceptCatchAll: config.accept_catch_all_guesses,
      timeoutSec: PATTERN_MV_VERIFY_TIMEOUT_SEC,
      deadlineMs,
      concurrency: PATTERN_MV_CONCURRENCY,
    });
  } catch (err) {
    if (err instanceof MillionVerifierError && err.definitive) {
      await recordMvDefinitiveError(admin, run.organization_id, org?.millionverifier_error_streak ?? 0, err);
      await admin
        .from("enrichment_runs")
        .update({ progress_message: `Waterfall held — ${err.message.slice(0, 150)}`, locked_at: null })
        .eq("id", run.id);
      return { status: "mv_error", kind: err.kind };
    }
    throw err; // unexpected — the tick's outer try/catch handles it
  }

  // Fetch the batch's contacts for fill-only writes.
  const contactIds = Array.from(new Set(batch.map((b) => b.contact_id)));
  const contactMap = new Map<string, Contact>();
  for (let i = 0; i < contactIds.length; i += 300) {
    const part = contactIds.slice(i, i + 300);
    const { data } = await admin
      .from("contacts")
      .select("id, email, enrichment_data, tags, status")
      .eq("organization_id", run.organization_id)
      .in("id", part);
    for (const c of (data as Contact[] | null) ?? []) contactMap.set(c.id, c);
  }

  let found = 0;
  let notFound = 0;
  let skipped = 0;
  let inconclusive = 0;
  let totalCredits = 0;

  for (const item of batch) {
    const outcome = outcomes.get(item.id);
    if (!outcome) continue; // hit the deadline — stays pending for the next tick
    totalCredits += outcome.credits;
    const share = outcome.credits * MV_CREDIT_COST_USD;

    if (outcome.kind === "found") {
      const contact = contactMap.get(item.contact_id);
      const res: PhaseResult = {
        status: "found",
        email: outcome.email,
        confidence: outcome.confidence,
        extra: { waterfall_status: outcome.mvResult },
      };
      const r = await writeEmail(admin, cols, item, res, contact, "pattern_mv", share, "pattern_mv");
      if (r === "found") found++;
      else if (r === "skipped") skipped++;
      else notFound++;
    } else if (outcome.kind === "not_found") {
      await admin
        .from("enrichment_run_items")
        .update({ waterfall_status: "not_found", waterfall_notes: outcome.note, cost_usd: share })
        .eq("id", item.id);
      notFound++;
    } else {
      // inconclusive — retry unless we've hit the attempt cap.
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= MAX_ITEM_ATTEMPTS) {
        await admin
          .from("enrichment_run_items")
          .update({
            waterfall_status: "not_found",
            waterfall_notes: `inconclusive after ${attempts} attempts: ${outcome.note}`,
            cost_usd: share,
          })
          .eq("id", item.id);
        notFound++;
      } else {
        await admin
          .from("enrichment_run_items")
          .update({ attempts, cost_usd: share })
          .eq("id", item.id);
        inconclusive++;
      }
    }
  }

  if (totalCredits > 0) {
    const add = totalCredits * MV_CREDIT_COST_USD;
    await admin
      .from("enrichment_runs")
      .update({ cost_usd: (Number(run.cost_usd) || 0) + add })
      .eq("id", run.id);
    run.cost_usd = (Number(run.cost_usd) || 0) + add;
  }

  await admin
    .from("enrichment_runs")
    .update({
      progress_message: `Pattern+verify: ${found} found · ${notFound} miss · ${inconclusive} retrying (${totalCredits} MV credits)`,
      locked_at: null,
    })
    .eq("id", run.id);

  return { status: "pattern_mv", found, not_found: notFound, skipped, inconclusive, credits: totalCredits };
}

// Process one domain-discovery batch inline (no Apify run) — the domains-phase
// fallback for contacts whose employer has no LinkedIn page. Web-looks-up each
// company's website (Perplexity Sonar, else Claude web_search), strictly
// validates it (name↔domain + citation + homepage), and writes company_domain
// fill-only so the email waterfall can run. Per-item failures are inconclusive
// (retried to the attempt cap); no key → not_found with a config note (run
// continues). Never uses in_flight — recoverOrphans would reset it.
async function runDomainDiscoveryBatch(
  admin: Admin,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
  tickStart: number,
): Promise<Record<string, unknown>> {
  const settings = normalizeEnrichmentSettings(run.waterfall_config ?? undefined);
  // Defensive: discovery turned off after this run was seeded → finish the
  // name-only pending items rather than loop.
  if (!settings.domain_discovery_enabled) {
    await admin
      .from("enrichment_run_items")
      .update({ domain_status: "not_found", domain_notes: "website discovery disabled in settings" })
      .eq("run_id", run.id)
      .eq("domain_status", "pending")
      .is("company_id", null)
      .is("company_slug", null)
      .not("company_name", "is", null);
    return { status: "discovery_disabled" };
  }

  // Org keys — Perplexity preferred, Claude web_search fallback.
  const { data: orgRow } = await admin
    .from("organizations")
    .select("anthropic_api_key, perplexity_api_key")
    .eq("id", run.organization_id)
    .maybeSingle();
  const org = orgRow as { anthropic_api_key: string | null; perplexity_api_key: string | null } | null;
  const perplexityKey = org?.perplexity_api_key?.trim() || process.env.PERPLEXITY_API_KEY?.trim() || null;
  const anthropicKey = org?.anthropic_api_key?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || null;

  // Claim a batch of name-only pending domain items.
  const { data: pendingData } = await admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", run.id)
    .eq("domain_status", "pending")
    .is("company_id", null)
    .is("company_slug", null)
    .not("company_name", "is", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(DISCOVERY_BATCH);
  let batch = (pendingData as ItemRow[] | null) ?? [];
  if (batch.length === 0) return { status: "skipped_batch" };
  batch = await dropAlreadyDone(admin, run, "domains", cols, batch);
  if (batch.length === 0) return { status: "skipped_batch" };

  // Neither key → discovery can't run. Mark not_found with a config-gap note.
  if (!perplexityKey && !anthropicKey) {
    await admin
      .from("enrichment_run_items")
      .update({
        domain_status: "not_found",
        domain_notes: "Anthropic or Perplexity API key required for website discovery (Settings → Integrations)",
      })
      .eq("run_id", run.id)
      .in("id", batch.map((b) => b.id));
    return { status: "no_discovery_key", items: batch.length };
  }

  // Fetch contacts for location + fill-only writes. `location` (00078) is the
  // first-class column; the enrichment_data dig is the pre-00078 fallback.
  type DiscoveryContact = Contact & { location?: string | null };
  const contactIds = Array.from(new Set(batch.map((b) => b.contact_id)));
  const contactMap = new Map<string, DiscoveryContact>();
  for (let i = 0; i < contactIds.length; i += 300) {
    const part = contactIds.slice(i, i + 300);
    const { data } = await admin
      .from("contacts")
      .select("id, email, location, enrichment_data, tags, status")
      .eq("organization_id", run.organization_id)
      .in("id", part);
    for (const c of (data as DiscoveryContact[] | null) ?? []) contactMap.set(c.id, c);
  }

  const providerLabel = perplexityKey ? "sonar" : "claude-web-search";
  const llm: LlmSearchFn = perplexityKey
    ? async (prompt) => {
        const r = await callPerplexity(perplexityKey, prompt, "sonar", {
          maxTokens: 300,
          searchRecencyFilter: null,
        });
        return { text: r.text, citations: r.citations, cost: r.cost };
      }
    : async (prompt) => {
        const anthropic = new Anthropic({ apiKey: anthropicKey as string });
        const message = await anthropic.messages.create({
          model: HAIKU_MODEL_ID,
          max_tokens: 1024,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ type: "web_search_20250305", name: "web_search" } as any],
          messages: [{ role: "user", content: prompt }],
        });
        const cost = calculateCost(
          { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
          HAIKU_MODEL_ID,
        );
        const textBlocks = message.content.filter(
          (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
        );
        const lastText = textBlocks[textBlocks.length - 1];
        // Grounding URLs from web_search_tool_result blocks → citations.
        const citations: string[] = [];
        for (const b of message.content) {
          const bb = b as { type?: string; content?: unknown };
          if (bb.type === "web_search_tool_result" && Array.isArray(bb.content)) {
            for (const rr of bb.content as Array<{ url?: unknown }>) {
              if (typeof rr.url === "string") citations.push(rr.url);
            }
          }
        }
        return { text: lastText ? lastText.text : "", citations, cost };
      };

  const guardedFetch = (url: string): Promise<string> =>
    isSafeUrl(url) ? fetchPage(url) : Promise.resolve("");

  const items: DiscoveryItem[] = batch.map((b) => {
    const contact = contactMap.get(b.contact_id);
    return {
      id: b.id,
      companyName: b.company_name ?? "",
      location: contact?.location?.trim() || extractContactLocation(contact?.enrichment_data),
    };
  });

  const outcomes = await runDomainDiscovery(items, llm, guardedFetch, {
    deadlineMs: tickStart + DISCOVERY_DEADLINE_SEC * 1000,
    concurrency: DISCOVERY_CONCURRENCY,
    providerLabel,
  });

  let found = 0;
  let notFound = 0;
  let inconclusive = 0;
  let totalCost = 0;

  for (const item of batch) {
    const outcome = outcomes.get(item.id);
    if (!outcome) continue; // deadline — stays pending for the next tick
    totalCost += outcome.cost;

    if (outcome.kind === "found") {
      const contact = contactMap.get(item.contact_id);
      const res: PhaseResult = {
        status: "found",
        companyDomain: outcome.domain,
        extra: {
          found_note: outcome.note,
          company: {
            domain: outcome.domain,
            name: item.company_name,
            discovered_via: providerLabel,
            resolved_at: new Date().toISOString(),
          },
        },
      };
      const r = await writePhaseResult(admin, run, "domains", cols, item, res, contact, outcome.cost);
      if (r === "found") found++;
      else notFound++;
    } else if (outcome.kind === "not_found") {
      await admin
        .from("enrichment_run_items")
        .update({ domain_status: "not_found", domain_notes: outcome.note, cost_usd: outcome.cost })
        .eq("id", item.id);
      notFound++;
    } else {
      // inconclusive — retry unless we've hit the attempt cap.
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= MAX_ITEM_ATTEMPTS) {
        await admin
          .from("enrichment_run_items")
          .update({
            domain_status: "not_found",
            domain_notes: `inconclusive after ${attempts} attempts: ${outcome.note}`,
            cost_usd: outcome.cost,
          })
          .eq("id", item.id);
        notFound++;
      } else {
        await admin
          .from("enrichment_run_items")
          .update({ attempts, cost_usd: outcome.cost })
          .eq("id", item.id);
        inconclusive++;
      }
    }
  }

  if (totalCost > 0) {
    await admin
      .from("enrichment_runs")
      .update({ cost_usd: (Number(run.cost_usd) || 0) + totalCost })
      .eq("id", run.id);
    run.cost_usd = (Number(run.cost_usd) || 0) + totalCost;
  }

  await admin
    .from("enrichment_runs")
    .update({
      progress_message: `Website lookup: ${found} found · ${notFound} miss${inconclusive ? ` · ${inconclusive} retrying` : ""}`,
      locked_at: null,
    })
    .eq("id", run.id);

  return { status: "domain_discovery", found, not_found: notFound, inconclusive };
}

// ---------------------------------------------------------------- naming phase

// Dig the Maps category + business city/state stamped on a contact's
// enrichment_data at import (import-maps-places), for the naming input.
function namingContext(ed: unknown): { category: string | null; city: string | null; state: string | null } {
  if (!ed || typeof ed !== "object") return { category: null, city: null, state: null };
  const o = ed as Record<string, unknown>;
  const sr = (o.source_row && typeof o.source_row === "object" ? (o.source_row as Record<string, unknown>) : {});
  const catRaw = sr.category ?? sr.category_label;
  const category = typeof catRaw === "string" && catRaw.trim() ? catRaw.trim() : null;
  const city = typeof o.city === "string" && o.city.trim() ? o.city.trim() : null;
  const state = typeof o.state === "string" && o.state.trim() ? o.state.trim() : null;
  return { category, city, state };
}

// Process one naming batch inline (no Apify run) — the opt-in owner-name add-on.
// Runs the decision-maker orchestrator (Layer 1 site scrape → Layer 2 web search)
// per name-less item, writing first/last/title onto the item AND the contact so
// the waterfall's pattern_mv can then build a personal email from name + domain
// (and a returned personal email is written straight through as provider
// 'decision_maker'). No Anthropic key → not_found with a config note (run
// continues). Per-item errors retry to the attempt cap. Never uses in_flight —
// recoverOrphans would reset it.
async function runNamingBatch(
  admin: Admin,
  client: ApifyClient, // only for advancePhase's completion-time cost reconcile
  run: RunRow,
  tickStart: number,
): Promise<Record<string, unknown>> {
  const cols = PHASE_COLS.naming;

  // Org keys — Anthropic is mandatory (Layer 1 is Haiku); Perplexity optional
  // (Layer 2 falls back to Claude web_search when it's absent).
  const { data: orgRow } = await admin
    .from("organizations")
    .select("anthropic_api_key, perplexity_api_key")
    .eq("id", run.organization_id)
    .maybeSingle();
  const org = orgRow as { anthropic_api_key: string | null; perplexity_api_key: string | null } | null;
  const anthropicKey = org?.anthropic_api_key?.trim() || process.env.ANTHROPIC_API_KEY?.trim() || null;
  const perplexityKey = org?.perplexity_api_key?.trim() || process.env.PERPLEXITY_API_KEY?.trim() || null;

  // No Anthropic key → naming can't run. Mark ALL pending naming items not_found
  // with a config note and complete the phase (mirrors verify's no-key path).
  if (!anthropicKey) {
    await admin
      .from("enrichment_run_items")
      .update({
        naming_status: "not_found",
        naming_notes: "Anthropic API key required for owner-name discovery (Settings → Integrations)",
      })
      .eq("run_id", run.id)
      .eq("naming_status", "pending");
    await advancePhase(admin, client, run);
    return { status: "no_naming_key", phase: run.phase };
  }

  // Claim a batch of pending naming items.
  const { data: pendingData } = await admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", run.id)
    .eq("naming_status", "pending")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(NAMING_BATCH);
  let batch = (pendingData as ItemRow[] | null) ?? [];
  // Nothing pending → the phase is done; advance (mirrors runVerifyPhase).
  if (batch.length === 0) {
    await advancePhase(admin, client, run);
    return { status: "advanced", phase: run.phase };
  }
  batch = await dropAlreadyDone(admin, run, "naming", cols, batch);
  if (batch.length === 0) return { status: "skipped_batch" };

  // Fetch contacts for input construction + fill-only writes.
  type NamingContact = Contact & {
    first_name?: string | null;
    last_name?: string | null;
    title?: string | null;
    company_email?: string | null;
    location?: string | null;
  };
  const contactIds = Array.from(new Set(batch.map((b) => b.contact_id)));
  const contactMap = new Map<string, NamingContact>();
  for (let i = 0; i < contactIds.length; i += 300) {
    const part = contactIds.slice(i, i + 300);
    const { data } = await admin
      .from("contacts")
      .select("id, email, first_name, last_name, title, company_email, location, enrichment_data, tags, status")
      .eq("organization_id", run.organization_id)
      .in("id", part);
    for (const c of (data as NamingContact[] | null) ?? []) contactMap.set(c.id, c);
  }

  // Concurrency pool over enrichBusiness; items past the deadline stay pending.
  const deadlineMs = tickStart + NAMING_DEADLINE_SEC * 1000;
  let cursor = 0;
  const outcomes = new Map<string, EnrichmentResult>();
  const worker = async (): Promise<void> => {
    for (;;) {
      if (Date.now() >= deadlineMs) return;
      const i = cursor++;
      if (i >= batch.length) return;
      const item = batch[i];
      const contact = contactMap.get(item.contact_id);
      const { category, city, state } = namingContext(contact?.enrichment_data);
      const input: EnrichmentInput = {
        business_name: item.company_name ?? "",
        website: item.company_domain ? `https://${item.company_domain}` : null,
        category,
        city: city ?? contact?.location ?? null,
        state,
        generic_email: contact?.company_email ?? null,
      };
      try {
        const res = await enrichBusiness(input, {
          serviceType: "operations",
          useLayer2: true, // uses Perplexity if present, else Claude web_search
          anthropicKey: anthropicKey as string,
          perplexityKey: perplexityKey ?? undefined,
          perBusinessTimeoutMs: NAMING_PER_BUSINESS_TIMEOUT_MS,
        });
        outcomes.set(item.id, res);
      } catch (err) {
        outcomes.set(item.id, {
          first_name: null,
          last_name: null,
          title: null,
          personal_email: null,
          other_emails: [],
          enrichment_source: null,
          enrichment_notes: err instanceof Error ? err.message : String(err),
          status: "error",
          cost_usd: 0,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(NAMING_CONCURRENCY, batch.length) }, () => worker()));

  let found = 0;
  let notFound = 0;
  let inconclusive = 0;
  let totalCost = 0;
  const now = new Date().toISOString();

  for (const item of batch) {
    const outcome = outcomes.get(item.id);
    if (!outcome) continue; // deadline — stays pending for the next tick
    totalCost += outcome.cost_usd;
    const contact = contactMap.get(item.contact_id);

    // A name was found → write it to the item (so seedWaterfallItems routes to
    // pattern_mv) and fill-only to the contact, plus any personal email.
    if (outcome.first_name && contact) {
      // 1) Provenance + fill-only name/title on the contact.
      let curEd = mergeEnrichment(contact.enrichment_data, {
        decision_maker: {
          provider: "decision_maker",
          first_name: outcome.first_name,
          last_name: outcome.last_name,
          title: outcome.title,
          source: outcome.enrichment_source,
          found_at: now,
        },
      });
      const { data: nameUpd } = await admin
        .from("contacts")
        .update({
          first_name: outcome.first_name,
          last_name: outcome.last_name,
          title: outcome.title,
          enrichment_data: curEd,
        })
        .eq("id", contact.id)
        .is("first_name", null)
        .select("id");
      if (!nameUpd || nameUpd.length === 0) {
        // Name already set since we read it — still record provenance.
        await admin.from("contacts").update({ enrichment_data: curEd }).eq("id", contact.id);
      }

      // 2) Personal email, if the layers returned one — sanitize, then fill-only.
      let itemEmail: string | null = null;
      if (outcome.personal_email) {
        const san = sanitizeFoundEmail(outcome.personal_email, {
          firstName: outcome.first_name,
          lastName: outcome.last_name,
          domain: item.company_domain,
        });
        if (san.email) {
          curEd = mergeEnrichment(curEd, {
            email: { provider: "decision_maker", email: san.email, confidence: 70, provider_status: null, found_at: now },
          });
          const tags = Array.from(new Set([...(contact.tags ?? []), "enriched", "decision_maker"]));
          const { data: eUpd, error: eErr } = await admin
            .from("contacts")
            .update({ email: san.email, tags, enrichment_data: curEd })
            .eq("id", contact.id)
            .is("email", null)
            .select("id");
          if (!eErr && eUpd && eUpd.length > 0) {
            itemEmail = san.email;
          } else {
            // 23505 (email on another contact) or a race → keep the name, record
            // the conflict, leave the item email null (waterfall may still try).
            const ed2 = mergeEnrichment(curEd, {
              email_conflict: { provider: "decision_maker", email: san.email },
            });
            await admin.from("contacts").update({ enrichment_data: ed2 }).eq("id", contact.id);
          }
        }
      }

      const notes = [outcome.enrichment_source, outcome.enrichment_notes]
        .filter(Boolean)
        .join(": ")
        .slice(0, 300);
      await admin
        .from("enrichment_run_items")
        .update({
          naming_status: "found",
          first_name: outcome.first_name,
          last_name: outcome.last_name,
          title: outcome.title,
          ...(itemEmail ? { email: itemEmail, email_provider: "decision_maker" } : {}),
          naming_notes: notes || null,
          cost_usd: outcome.cost_usd,
        })
        .eq("id", item.id);
      found++;
    } else if (outcome.status === "error") {
      // Retry unless we've hit the attempt cap.
      const attempts = (item.attempts ?? 0) + 1;
      if (attempts >= MAX_ITEM_ATTEMPTS) {
        await admin
          .from("enrichment_run_items")
          .update({
            naming_status: "not_found",
            naming_notes: `error after ${attempts} attempts: ${outcome.enrichment_notes}`.slice(0, 300),
            cost_usd: outcome.cost_usd,
          })
          .eq("id", item.id);
        notFound++;
      } else {
        await admin
          .from("enrichment_run_items")
          .update({ attempts, cost_usd: outcome.cost_usd })
          .eq("id", item.id);
        inconclusive++;
      }
    } else {
      // Completed but no name found.
      await admin
        .from("enrichment_run_items")
        .update({
          naming_status: "not_found",
          naming_notes: (outcome.enrichment_notes || "no decision-maker found").slice(0, 300),
          cost_usd: outcome.cost_usd,
        })
        .eq("id", item.id);
      notFound++;
    }
  }

  if (totalCost > 0) {
    await admin
      .from("enrichment_runs")
      .update({ cost_usd: (Number(run.cost_usd) || 0) + totalCost })
      .eq("id", run.id);
    run.cost_usd = (Number(run.cost_usd) || 0) + totalCost;
  }

  await admin
    .from("enrichment_runs")
    .update({
      progress_message: `Owner names: ${found} found · ${notFound} miss${inconclusive ? ` · ${inconclusive} retrying` : ""}`,
      locked_at: null,
    })
    .eq("id", run.id);

  return { status: "naming", found, not_found: notFound, inconclusive };
}

// ---------------------------------------------------------------- verify phase

// A found email's verify columns. `found` == verified clean (MV "ok");
// everything else is `not_found` with the MV verdict in verification_result so
// the report can show the nuance (catch_all/unknown/invalid/disposable/error).
async function writeVerifyItem(
  admin: Admin,
  itemId: string,
  mvResult: string,
  note: string | null,
): Promise<void> {
  await admin
    .from("enrichment_run_items")
    .update({
      verify_status: mvResult === "ok" ? "found" : "not_found",
      verification_result: mvResult,
      verify_notes: note,
    })
    .eq("id", itemId);
}

// The opt-in verification phase (run_verify): Million Verifier each found email
// so the enrichment report carries a verdict. Inline, no Apify. Fill-only on the
// contact's verification columns (00069) — MV is the single source of truth, so
// the send-gate later reads this from its 30-day cache (no double spend). Cache
// hits (<30d) cost nothing. Fail-closed on a definitive MV error; no key marks
// the phase's items skipped with a config note and completes the phase.
async function runVerifyPhase(
  admin: Admin,
  apify: ApifyClient, // only for advancePhase's completion-time cost reconcile
  run: RunRow,
  tickStart: number,
): Promise<Record<string, unknown>> {
  // Org MV key + error/suppression state (same source as pattern_mv).
  const { data: orgRow } = await admin
    .from("organizations")
    .select(
      "millionverifier_api_key, millionverifier_last_error_kind, millionverifier_last_error_at, millionverifier_error_streak",
    )
    .eq("id", run.organization_id)
    .maybeSingle();
  const org = orgRow as {
    millionverifier_api_key: string | null;
    millionverifier_last_error_kind: string | null;
    millionverifier_last_error_at: string | null;
    millionverifier_error_streak: number | null;
  } | null;
  const key = org?.millionverifier_api_key?.trim() || process.env.MILLIONVERIFIER_API_KEY?.trim() || null;

  // No key → verification can't run. Mark all pending verify items skipped with a
  // clear note (a config gap, not a silent miss) and complete the phase.
  if (!key) {
    await admin
      .from("enrichment_run_items")
      .update({
        verify_status: "skipped",
        verify_notes: "Million Verifier key required to verify emails (Settings → Integrations)",
      })
      .eq("run_id", run.id)
      .eq("verify_status", "pending");
    await advancePhase(admin, apify, run);
    return { status: "no_mv_key", phase: run.phase };
  }

  // Suppression window after a recent definitive error — hold, don't call MV.
  const kind = org?.millionverifier_last_error_kind;
  const definitive = !!kind && kind !== "transient";
  if (definitive && org?.millionverifier_last_error_at) {
    const at = Date.parse(org.millionverifier_last_error_at);
    if (!Number.isNaN(at) && Date.now() < at + ORG_ERROR_SUPPRESS_MS) {
      await admin
        .from("enrichment_runs")
        .update({ progress_message: "Verification held — email verifier unavailable (retrying shortly)", locked_at: null })
        .eq("id", run.id);
      return { status: "mv_suppressed" };
    }
  }

  // Claim a batch of pending verify items.
  const { data: pendingData } = await admin
    .from("enrichment_run_items")
    .select("id, contact_id, email")
    .eq("run_id", run.id)
    .eq("verify_status", "pending")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(VERIFY_BATCH);
  const batch = (pendingData as { id: string; contact_id: string; email: string | null }[] | null) ?? [];
  if (batch.length === 0) {
    await advancePhase(admin, apify, run);
    return { status: "advanced", phase: run.phase };
  }

  // Fetch contacts (current email + verification cache columns from 00069).
  type VRow = {
    id: string;
    email: string | null;
    email_verification_status: EmailVerificationStatus | null;
    email_verified_at: string | null;
    // Matches CacheView (decideFromCached tolerates a runtime null via `?? 0`).
    email_verification_attempts: number;
  };
  const contactIds = Array.from(new Set(batch.map((b) => b.contact_id)));
  const contactMap = new Map<string, VRow>();
  for (let i = 0; i < contactIds.length; i += 300) {
    const part = contactIds.slice(i, i + 300);
    const { data } = await admin
      .from("contacts")
      .select("id, email, email_verification_status, email_verified_at, email_verification_attempts")
      .eq("organization_id", run.organization_id)
      .in("id", part);
    for (const c of (data as VRow[] | null) ?? []) contactMap.set(c.id, c);
  }

  const client = new MillionVerifierClient(key);
  const now = new Date();
  const deadlineMs = tickStart + VERIFY_DEADLINE_SEC * 1000;
  // MV charges for ok/invalid/disposable; catch_all + unknown are free.
  const CHARGED = new Set(["ok", "invalid", "disposable"]);

  let verified = 0; // clean 'ok'
  let risky = 0; // catch_all / unknown
  let bad = 0; // invalid / disposable / error
  let credits = 0;
  let processed = 0;
  // Boxed so the worker-closure assignment survives TS control-flow narrowing.
  const errBox: { e: MillionVerifierError | null } = { e: null };

  const tally = (status: string) => {
    if (status === "ok") verified++;
    else if (status === "catch_all" || status === "unknown") risky++;
    else bad++;
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (errBox.e) return;
      if (Date.now() >= deadlineMs) return; // leftover items stay pending for next tick
      const idx = cursor++;
      if (idx >= batch.length) return;
      const item = batch[idx];
      const contact = contactMap.get(item.contact_id);
      const email = contact?.email ?? item.email ?? null;
      if (!email) {
        await admin
          .from("enrichment_run_items")
          .update({ verify_status: "skipped", verify_notes: "no email to verify" })
          .eq("id", item.id);
        processed++;
        continue;
      }

      // 30-day cache: reuse a fresh verdict with no API call (shared with the
      // send-gate). Only send/skip verdicts are terminal from cache; an
      // indeterminate cache entry falls through to a fresh call.
      if (contact) {
        const cached = decideFromCached(contact, now);
        if (cached.action === "send" || cached.action === "skip") {
          const status = contact.email_verification_status ?? (cached.action === "send" ? "ok" : "invalid");
          await writeVerifyItem(admin, item.id, status, "cached verdict (<30d)");
          tally(status);
          processed++;
          continue;
        }
      }

      // Live call.
      let res: MillionVerifierResponse;
      try {
        res = await client.verify(email, { timeoutSec: VERIFY_TIMEOUT });
      } catch (err) {
        if (err instanceof MillionVerifierError && err.definitive) {
          errBox.e = err;
          return;
        }
        // transient / per-address failure — leave pending, retry next tick.
        continue;
      }
      const { patch } = decideFromResult(res, contact?.email_verification_attempts ?? 0, now);
      // Persist onto the contact so the send-gate reuses it (MV single source).
      if (contact) {
        await admin.from("contacts").update(patch).eq("id", contact.id);
        Object.assign(contact, patch);
      }
      const status = patch.email_verification_status;
      if (CHARGED.has(status)) credits++;
      await writeVerifyItem(admin, item.id, status, null);
      tally(status);
      processed++;
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(VERIFY_CONCURRENCY, batch.length) }, () => worker()),
  );

  // Definitive MV failure mid-batch → record suppression + hold (leaves the rest
  // pending; the send-gate backs off too via the shared org state).
  if (errBox.e) {
    await recordMvDefinitiveError(admin, run.organization_id, org?.millionverifier_error_streak ?? 0, errBox.e);
    await admin
      .from("enrichment_runs")
      .update({ progress_message: `Verification held — ${errBox.e.message.slice(0, 150)}`, locked_at: null })
      .eq("id", run.id);
    return { status: "mv_error", kind: errBox.e.kind, processed };
  }

  if (credits > 0) {
    const add = credits * MV_CREDIT_COST_USD;
    await admin
      .from("enrichment_runs")
      .update({ cost_usd: (Number(run.cost_usd) || 0) + add })
      .eq("id", run.id);
    run.cost_usd = (Number(run.cost_usd) || 0) + add;
  }

  await admin
    .from("enrichment_runs")
    .update({
      progress_message: `Verify: ${verified} clean · ${risky} risky · ${bad} bad (${credits} MV credits)`,
      locked_at: null,
    })
    .eq("id", run.id);

  return { status: "verify", verified, risky, bad, credits, processed };
}

// Seed the waterfall phase: stamp each eligible item (no email, has a domain)
// with its size-band method from the run's config snapshot, and mark the 'off'
// band skipped. Returns the count of actionable (pending) items.
async function seedWaterfallItems(admin: Admin, run: RunRow): Promise<number> {
  const config = (run.waterfall_config ?? DEFAULT_ENRICHMENT_SETTINGS) as EnrichmentSettings;
  const { data } = await admin
    .from("enrichment_run_items")
    .select("id, employee_count, first_name, last_name")
    .eq("run_id", run.id)
    .is("waterfall_status", null)
    .is("email", null)
    .not("company_domain", "is", null);
  const rows =
    (data as { id: string; employee_count: number | null; first_name: string | null; last_name: string | null }[] | null) ??
    [];
  if (rows.length === 0) return 0;

  // Group by resolved method. Track name-less items (methodForItem routes them to
  // site_scrape) so we can stamp a provenance note — these are the Google-Maps
  // business leads with no decision-maker resolved yet.
  const groups = new Map<EnrichmentWaterfallMethod, string[]>();
  const namelessRouted: string[] = [];
  for (const r of rows) {
    const named = hasUsableName(r.first_name, r.last_name);
    const method = methodForItem(config, r.employee_count, named);
    if (!named && method !== "off") namelessRouted.push(r.id);
    const arr = groups.get(method) ?? [];
    arr.push(r.id);
    groups.set(method, arr);
  }

  let pending = 0;
  for (const [method, ids] of groups) {
    const patch =
      method === "off"
        ? { waterfall_status: "skipped", waterfall_method: "off", waterfall_notes: "waterfall off for this size band" }
        : { waterfall_status: "pending", waterfall_method: method, attempts: 0 };
    for (let i = 0; i < ids.length; i += 200) {
      await admin
        .from("enrichment_run_items")
        .update(patch)
        .in("id", ids.slice(i, i + 200));
    }
    if (method !== "off") pending += ids.length;
  }
  // Provenance note for the name-less → site_scrape routing (doesn't change state).
  for (let i = 0; i < namelessRouted.length; i += 200) {
    await admin
      .from("enrichment_run_items")
      .update({ waterfall_notes: "no person name — routed to site scrape" })
      .in("id", namelessRouted.slice(i, i + 200));
  }
  return pending;
}

// ---------------------------------------------------------------- ingest

async function ingest(
  admin: Admin,
  run: RunRow,
  phase: Exclude<EnrichmentPhase, "complete">,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  items: ItemRow[],
  datasetItems: unknown[],
): Promise<{ found: number; not_found: number; skipped: number }> {
  const cols = PHASE_COLS[phase];
  const results = provider.parseItems(datasetItems, items);
  const share = items.length > 0 ? estimatePerItem(phase) : 0;

  // Fetch the batch's contacts fresh (for fill-only writes + JSONB merge).
  const contactIds = Array.from(new Set(items.map((i) => i.contact_id)));
  const contactMap = new Map<string, Contact>();
  for (let i = 0; i < contactIds.length; i += 300) {
    const part = contactIds.slice(i, i + 300);
    const { data } = await admin
      .from("contacts")
      .select("id, email, enrichment_data, tags, status")
      .eq("organization_id", run.organization_id)
      .in("id", part);
    for (const c of (data as Contact[] | null) ?? []) {
      contactMap.set(c.id, c);
    }
  }

  let found = 0;
  let notFound = 0;
  let skipped = 0;

  for (const item of items) {
    const res = results.get(item.id) ?? { status: "not_found" as const };
    const contact = contactMap.get(item.contact_id);
    const outcome = await writePhaseResult(admin, run, phase, cols, item, res, contact, share);
    if (outcome === "found") found++;
    else if (outcome === "skipped") skipped++;
    else notFound++;
  }

  return { found, not_found: notFound, skipped };
}

type Contact = { id: string; email: string | null; enrichment_data: unknown; tags: string[] | null; status: string };

async function writePhaseResult(
  admin: Admin,
  run: RunRow,
  phase: Exclude<EnrichmentPhase, "complete">,
  cols: { status: string; runId: string; notes: string },
  item: ItemRow,
  res: PhaseResult,
  contact: Contact | undefined,
  share: number,
): Promise<"found" | "not_found" | "skipped"> {
  const now = new Date().toISOString();

  if (phase === "domains") {
    // Company-level extras the harvestapi actor already returns (migration
    // 00075): the company phone fills contacts.company_phone (migration 00076 —
    // NOT contacts.phone, which is reserved for the decision-maker's own line)
    // fill-only, zero extra spend; employeeCount lands on the item — the
    // waterfall's size-routing input. Both exist even when the record had no
    // usable website (not_found path).
    const company = (res.extra?.company ?? null) as Record<string, unknown> | null;
    const phone =
      company && typeof company.phone === "string" && company.phone.trim()
        ? (company.phone as string).trim()
        : null;
    const employeeCount =
      company && typeof company.employeeCount === "number" && Number.isFinite(company.employeeCount)
        ? Math.round(company.employeeCount as number)
        : null;
    if (contact && phone) {
      await admin.from("contacts").update({ company_phone: phone }).eq("id", contact.id).is("company_phone", null);
    }
    const employeeCountPatch = employeeCount != null ? { employee_count: employeeCount } : {};

    if (res.status === "found" && res.companyDomain) {
      if (contact) {
        const ed = mergeEnrichment(contact.enrichment_data, {
          company: (res.extra?.company as Record<string, unknown>) ?? { domain: res.companyDomain },
        });
        await admin
          .from("contacts")
          .update({ company_domain: res.companyDomain, enrichment_data: ed })
          .eq("id", contact.id)
          .is("company_domain", null);
      }
      await admin
        .from("enrichment_run_items")
        .update({
          domain_status: "found",
          company_domain: res.companyDomain,
          // Discovery supplies its own provenance ("discovered via sonar —
          // homepage-confirmed"); the linkedin-company actor supplies matched_by.
          domain_notes:
            (res.extra?.found_note as string) ??
            (res.extra?.matched_by ? `matched by ${res.extra.matched_by}` : null),
          cost_usd: share,
          ...employeeCountPatch,
        })
        .eq("id", item.id);
      return "found";
    }
    await admin
      .from("enrichment_run_items")
      .update({
        domain_status: "not_found",
        domain_notes: (res.extra?.domain_note as string) ?? "no company domain found",
        cost_usd: share,
        ...employeeCountPatch,
      })
      .eq("id", item.id);
    return "not_found";
  }

  if (phase === "activity") {
    const lastPosted = (res.extra?.last_posted_at as string | null | undefined) ?? null;
    const recentCount =
      typeof res.extra?.recent_post_count === "number" ? (res.extra.recent_post_count as number) : null;
    if (res.status === "found") {
      if (contact) {
        await admin
          .from("contacts")
          .update({ last_posted_at: lastPosted, recent_post_count: recentCount, activity_checked_at: now })
          .eq("id", contact.id);
      }
      await admin
        .from("enrichment_run_items")
        .update({ activity_status: "found", last_posted_at: lastPosted, recent_post_count: recentCount, cost_usd: share })
        .eq("id", item.id);
      return "found";
    }
    // No posts — still stamp checked-at so we know we looked (recency = none).
    if (contact) {
      await admin
        .from("contacts")
        .update({ activity_checked_at: now, recent_post_count: 0 })
        .eq("id", contact.id);
    }
    await admin
      .from("enrichment_run_items")
      .update({
        activity_status: "not_found",
        recent_post_count: 0,
        activity_notes: (res.extra?.activity_note as string) ?? "no recent posts",
        cost_usd: share,
      })
      .eq("id", item.id);
    return "not_found";
  }

  // profiles | waterfall — both produce an email via writeEmail. profiles also
  // backfills the company LinkedIn URL for the domain phase.
  if (phase === "profiles" && res.companyLinkedinUrl && !item.company_linkedin_url) {
    await admin
      .from("enrichment_run_items")
      .update({
        company_linkedin_url: res.companyLinkedinUrl,
        company_id: extractCompanyId(res.companyLinkedinUrl),
        company_slug: extractCompanySlug(res.companyLinkedinUrl),
      })
      .eq("id", item.id);
    if (contact) {
      await admin
        .from("contacts")
        .update({ company_linkedin_url: res.companyLinkedinUrl })
        .eq("id", contact.id)
        .is("company_linkedin_url", null);
    }
  }

  const providerId: EmailProviderId = phase === "profiles" ? "harvestapi" : waterfallProviderId(run);
  return writeEmail(admin, cols, item, res, contact, providerId, share);
}

function waterfallProviderId(run: RunRow): EmailProviderId {
  const a = run.waterfall_actor ?? "";
  if (a.includes("site-contact-scraper")) return "site_scrape";
  return "bovi";
}

// Friendly method name for the run-banner progress line.
function waterfallMethodLabel(actor: string | null): string {
  const a = actor ?? "";
  if (a.includes("site-contact-scraper")) return "Site scrape";
  if (a.includes("bovi")) return "Pattern finder";
  return "Second pass";
}

// Finish a waterfall item that produced no usable personal email. Company-level
// scrape extras (generic emails) still get persisted, and a scrape_plus_pattern
// item is handed to its stage-2 pattern_mv pass instead of ending here. Returns
// "skipped" for that handoff (deferred), "not_found" otherwise.
async function finishWaterfallMiss(
  admin: Admin,
  cols: { status: string; runId: string; notes: string },
  item: ItemRow,
  contact: Contact | undefined,
  extraPatch: Record<string, unknown>,
  note: string,
  share: number,
): Promise<"found" | "not_found" | "skipped"> {
  if (contact && extraPatch.company_emails) {
    const ed = mergeEnrichment(contact.enrichment_data, { company_emails: extraPatch.company_emails });
    await admin.from("contacts").update({ enrichment_data: ed }).eq("id", contact.id);
  }
  const named = hasUsableName(item.first_name, item.last_name);
  // scrape_plus_pattern hands a scrape miss to pattern_mv — but only with a name
  // to build guesses from. A name-less miss can't be helped by pattern_mv, so it
  // falls through to the generic-inbox backfill / terminal path below.
  if (item.waterfall_method === "scrape_plus_pattern" && named) {
    await admin
      .from("enrichment_run_items")
      .update({
        waterfall_status: "pending",
        waterfall_method: "pattern_mv",
        attempts: 0,
        waterfall_notes: "scrape found no personal email; trying pattern+verify",
        cost_usd: share,
      })
      .eq("id", item.id);
    return "skipped";
  }

  // Generic-inbox backfill: for a name-less business lead with no personal email,
  // a scraped company inbox (info@/contact@) IS the actionable address — the
  // native sender mails contacts.email and skips email-less rows, so a generic
  // living only in company_email would be unsendable. Fill contacts.email
  // (fill-only) with the generic at low confidence + provenance so the lead is
  // usable. Deliberate, documented exception to the 00076 person-email reservation,
  // gated on !named so decision-maker rows keep the strict person-only contract.
  const genericEmail =
    typeof extraPatch.company_email === "string" ? extraPatch.company_email.trim().toLowerCase() : "";
  if (!named && genericEmail && contact && !contact.email) {
    const now = new Date().toISOString();
    const ed = mergeEnrichment(contact.enrichment_data, {
      email: { provider: "site_scrape", kind: "company_generic", email: genericEmail, confidence: 30, found_at: now },
    });
    const tags = Array.from(new Set([...(contact.tags ?? []), "enriched", "site_scrape"]));
    const { data: updated, error } = await admin
      .from("contacts")
      .update({ email: genericEmail, tags, enrichment_data: ed })
      .eq("id", contact.id)
      .is("email", null)
      .select("id");
    if (!error && updated && updated.length > 0) {
      await admin
        .from("enrichment_run_items")
        .update({
          [cols.status]: "found",
          email: genericEmail,
          email_provider: "site_scrape",
          confidence: 30,
          [cols.notes]: "generic company inbox (no decision-maker name)",
          cost_usd: share,
        })
        .eq("id", item.id);
      return "found";
    }
    // 23505 (email already on another contact) or a race → fall through to the
    // terminal miss below rather than throwing.
  }

  await admin
    .from("enrichment_run_items")
    .update({ [cols.status]: "not_found", [cols.notes]: note, cost_usd: share })
    .eq("id", item.id);
  return "not_found";
}

// Guard scraped phones before they touch contacts.phone. The site-contact-scraper
// already hardens these, but an older actor build (or a manual run) could still
// hand back a copyright year-range or date stamp — never write one to a CRM field.
function isPlausibleContactPhone(raw: string): boolean {
  const s = raw.trim();
  if (/(^|\D)(19|20)\d{2}\s*[-–—]\s*(19|20)\d{2}(\D|$)/.test(s)) return false; // 1996-2026
  if (/(^|\D)(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])(\D|$)/.test(s)) return false; // 2004-02-07
  const d = s.replace(/\D/g, "");
  if (d.length < 7 || d.length > 15) return false;
  if (/^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(d)) return false; // YYYYMMDD
  if (/^(19|20)\d{2}(19|20)\d{2}$/.test(d)) return false; // YYYYYYYY concatenated years
  return true;
}

async function writeEmail(
  admin: Admin,
  cols: { status: string; runId: string; notes: string },
  item: ItemRow,
  res: PhaseResult,
  contact: Contact | undefined,
  providerId: EmailProviderId,
  share: number,
  // Contact tag recording the source; Apify providers stay "apify", the direct
  // methods get their own tag so provenance isn't mislabeled.
  sourceTag = "apify",
): Promise<"found" | "not_found" | "skipped"> {
  const now = new Date().toISOString();
  const extraPatch = (res.extra ?? {}) as Record<string, unknown>;
  const companyEmailsPatch = extraPatch.company_emails ? { company_emails: extraPatch.company_emails } : {};

  // Company-level data (from a site scrape) fills the dedicated company_* columns
  // fill-only, regardless of the personal-email outcome. contacts.email/phone stay
  // reserved for the decision-maker's own details (migration 00076).
  if (contact) {
    const rawPhone =
      typeof extraPatch.company_phone === "string" ? (extraPatch.company_phone as string).trim() : "";
    const companyPhone = rawPhone && isPlausibleContactPhone(rawPhone) ? rawPhone : null;
    if (companyPhone) {
      await admin.from("contacts").update({ company_phone: companyPhone }).eq("id", contact.id).is("company_phone", null);
    }
    const companyEmail =
      typeof extraPatch.company_email === "string" ? (extraPatch.company_email as string).trim().toLowerCase() : "";
    if (companyEmail) {
      await admin.from("contacts").update({ company_email: companyEmail }).eq("id", contact.id).is("company_email", null);
    }
  }

  if (res.status !== "found" || !res.email) {
    return finishWaterfallMiss(admin, cols, item, contact, extraPatch, "no email found", share);
  }

  const san = sanitizeFoundEmail(res.email, {
    firstName: item.first_name,
    lastName: item.last_name,
    domain: item.company_domain,
  });
  if (!san.email) {
    return finishWaterfallMiss(admin, cols, item, contact, extraPatch, `provider junk email: ${san.rejectReason}`, share);
  }

  const noteFlags = san.flags.length ? san.flags.join("; ") : null;
  // The provider's own status string (e.g. bovi/scrape verdict), kept as
  // provenance only — never a verification verdict. Million Verifier is the
  // authority, applied later at its pre-send gate.
  const providerStatus = (extraPatch.waterfall_status as string | null | undefined) ?? null;

  // Fill-only write of the email onto the contact. This worker NEVER writes
  // email_verification_* — those columns are Million Verifier's (single source
  // of truth). We only fill the address + record provenance in enrichment_data.
  if (contact) {
    const ed = mergeEnrichment(contact.enrichment_data, {
      email: { provider: providerId, email: san.email, confidence: res.confidence ?? null, provider_status: providerStatus, found_at: now },
      ...companyEmailsPatch,
    });
    const tags = Array.from(new Set([...(contact.tags ?? []), "enriched", sourceTag]));
    const { data: updated, error } = await admin
      .from("contacts")
      .update({
        email: san.email,
        tags,
        enrichment_data: ed,
      })
      .eq("id", contact.id)
      .is("email", null)
      .select("id");

    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Email already belongs to another contact in the org.
        const ed2 = mergeEnrichment(contact.enrichment_data, {
          email_conflict: { provider: providerId, email: san.email, provider_status: providerStatus, confidence: res.confidence ?? null },
        });
        await admin.from("contacts").update({ enrichment_data: ed2 }).eq("id", contact.id);
        await admin
          .from("enrichment_run_items")
          .update({
            [cols.status]: "skipped",
            email: san.email,
            [cols.notes]: "email already belongs to another contact in this org",
            cost_usd: share,
          })
          .eq("id", item.id);
        return "skipped";
      }
      throw error;
    }

    if (!updated || updated.length === 0) {
      // Contact gained an email between our select and update.
      await admin
        .from("enrichment_run_items")
        .update({ [cols.status]: "skipped", [cols.notes]: "contact already had an email", cost_usd: share })
        .eq("id", item.id);
      return "skipped";
    }
  }

  await admin
    .from("enrichment_run_items")
    .update({
      [cols.status]: "found",
      email: san.email,
      email_provider: providerId,
      confidence: res.confidence ?? null,
      [cols.notes]: noteFlags,
      cost_usd: share,
    })
    .eq("id", item.id);
  return "found";
}

// ---------------------------------------------------------------- helpers

async function fetchInFlight(admin: Admin, runId: string, statusCol: string): Promise<ItemRow[]> {
  const { data } = await admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", runId)
    .eq(statusCol, "in_flight")
    .limit(BATCH_SIZE * 2);
  return (data as ItemRow[] | null) ?? [];
}

async function dropAlreadyDone(
  admin: Admin,
  run: RunRow,
  phase: Exclude<EnrichmentPhase, "complete">,
  cols: { status: string; runId: string; notes: string },
  batch: ItemRow[],
): Promise<ItemRow[]> {
  const contactIds = batch.map((b) => b.contact_id);
  const { data } = await admin
    .from("contacts")
    .select("id, email, company_domain, first_name, last_name")
    .eq("organization_id", run.organization_id)
    .in("id", contactIds);
  const map = new Map(
    ((data as {
      id: string;
      email: string | null;
      company_domain: string | null;
      first_name: string | null;
      last_name: string | null;
    }[] | null) ?? []).map((c) => [c.id, c]),
  );

  const keep: ItemRow[] = [];
  const skipIds: string[] = [];
  for (const it of batch) {
    const c = map.get(it.contact_id);
    const done =
      phase === "domains"
        ? Boolean(c?.company_domain)
        : phase === "profiles" || phase === "waterfall"
          ? Boolean(c?.email)
          : // naming: the contact already has an email or a name → nothing to find.
            phase === "naming"
            ? Boolean(c?.email) || Boolean(c?.first_name) || Boolean(c?.last_name)
            : false;
    if (done) skipIds.push(it.id);
    else keep.push(it);
  }
  if (skipIds.length) {
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "skipped", [cols.notes]: "target already set on contact" })
      .in("id", skipIds);
  }
  return keep;
}

async function recoverOrphans(
  admin: Admin,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
): Promise<void> {
  // In-flight items with no active run on the run row are orphans from a crash.
  const { data } = await admin
    .from("enrichment_run_items")
    .select(`id, ${cols.runId}`)
    .eq("run_id", run.id)
    .eq(cols.status, "in_flight");
  const rows = (data as Record<string, string | null>[] | null) ?? [];
  if (rows.length === 0) return;
  // Without an active_apify_run_id on the run, we can't safely resume — put them
  // back to pending (Apify runs, if any, are cheap to re-do / already billed).
  const ids = rows.map((r) => r.id as string);
  await admin
    .from("enrichment_run_items")
    .update({ [cols.status]: "pending", [cols.runId]: null })
    .in("id", ids);
}

async function requeueOrFail(
  admin: Admin,
  run: RunRow,
  cols: { status: string; runId: string; notes: string },
  note: string,
): Promise<void> {
  const { data } = await admin
    .from("enrichment_run_items")
    .select("id, attempts")
    .eq("run_id", run.id)
    .eq(cols.status, "in_flight");
  const rows = (data as { id: string; attempts: number }[] | null) ?? [];
  // Retry (attempts+1) rows under the cap; error out the rest. Group by current
  // attempts count so the increment is correct without an RPC.
  const byAttempts = new Map<number, string[]>();
  const dead: string[] = [];
  for (const r of rows) {
    const a = r.attempts ?? 0;
    if (a < MAX_ITEM_ATTEMPTS) {
      const arr = byAttempts.get(a) ?? [];
      arr.push(r.id);
      byAttempts.set(a, arr);
    } else {
      dead.push(r.id);
    }
  }
  for (const [attempts, ids] of byAttempts) {
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "pending", [cols.runId]: null, attempts: attempts + 1 })
      .in("id", ids);
  }
  if (dead.length) {
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "error", [cols.notes]: note })
      .in("id", dead);
  }
}

async function clearActive(admin: Admin, runId: string): Promise<void> {
  await admin
    .from("enrichment_runs")
    .update({
      active_apify_run_id: null,
      active_apify_dataset_id: null,
      active_batch_started_at: null,
    })
    .eq("id", runId);
}

async function failRun(admin: Admin, runId: string, message: string): Promise<void> {
  await admin
    .from("enrichment_runs")
    .update({
      status: "failed",
      error_message: message,
      completed_at: new Date().toISOString(),
      locked_at: null,
      active_apify_run_id: null,
    })
    .eq("id", runId);
  await alertActorFailure(admin, { kind: "enrichment", error: message, context: { run_id: runId } });
}

// Stamp verify_status='pending' on every item that has an email (found this run
// or imported with one). Returns the count seeded (0 → nothing to verify).
async function seedVerifyItems(admin: Admin, run: RunRow): Promise<number> {
  const { data } = await admin
    .from("enrichment_run_items")
    .update({ verify_status: "pending", attempts: 0 })
    .eq("run_id", run.id)
    .is("verify_status", null)
    .not("email", "is", null)
    .select("id");
  return (data as { id: string }[] | null)?.length ?? 0;
}

// Final cost reconciliation at run completion. Per-batch accruals read a run's
// usageTotalUsd the moment it finished, but Apify posts pay-per-event charges
// asynchronously — a fast same-tick batch records ~$0 (compute only), so
// cost_usd can badly undercount (observed: $0.00005 recorded vs $0.028 billed).
// By completion every batch's charges have long settled, so re-read each
// distinct Apify run's FINAL usage and floor cost_usd with the sum. max() keeps
// the accrued figure when it's already higher (it also contains the non-Apify
// MV-credit + discovery-LLM shares); when the Apify sum alone exceeds it, the
// accrual provably under-captured and the reconciled figure is far closer to
// truth (short only by those small non-Apify shares). Best-effort — never fails
// the run.
async function reconcileRunCost(admin: Admin, client: ApifyClient, run: RunRow): Promise<void> {
  try {
    const RUN_ID_COLS = [
      "profile_apify_run_id",
      "domain_apify_run_id",
      "waterfall_apify_run_id",
      "activity_apify_run_id",
    ] as const;
    const ids = new Set<string>();
    for (let offset = 0; offset < 5000; offset += 1000) {
      const { data } = await admin
        .from("enrichment_run_items")
        .select(RUN_ID_COLS.join(", "))
        .eq("run_id", run.id)
        .range(offset, offset + 999);
      const rows = (data as unknown as Record<string, string | null>[] | null) ?? [];
      for (const r of rows) {
        for (const col of RUN_ID_COLS) {
          const v = r[col];
          if (v) ids.add(v);
        }
      }
      if (rows.length < 1000) break;
    }
    // No Apify runs (pure pattern_mv/discovery run) or an implausible pile-up —
    // leave the accrued figure alone.
    if (ids.size === 0 || ids.size > 40) return;

    let apifyFinal = 0;
    for (const id of ids) {
      try {
        const apRun = await client.getRun(id);
        if (typeof apRun.usageTotalUsd === "number") apifyFinal += apRun.usageTotalUsd;
      } catch {
        // best-effort per run
      }
    }
    const accrued = Number(run.cost_usd) || 0;
    if (apifyFinal > accrued) {
      await admin.from("enrichment_runs").update({ cost_usd: apifyFinal }).eq("id", run.id);
      run.cost_usd = apifyFinal;
    }
  } catch {
    // reconciliation must never break completion
  }
}

// Delivered-outcome ledger (Phase 5). At completion, classify each of the run's
// contacts by delivered tier (record / phone / company_email / owner_name /
// personal_email / verified_email) and roll the counts onto the run
// (outcome_counts) and — for search-sourced contacts — merge-increment the
// source search's delivered_counts. The margin substrate for future billing.
// Best-effort; never breaks completion. (A search enriched across multiple
// drain-merged runs accumulates; a rare manual re-enrichment can double-count —
// acceptable for a rough ledger.)
type ContactOutcomeRow = {
  id: string;
  email: string | null;
  email_verification_status: string | null;
  company_email: string | null;
  company_phone: string | null;
  phone: string | null;
  first_name: string | null;
  enrichment_data: unknown;
};
async function finalizeOutcomes(admin: Admin, run: RunRow): Promise<void> {
  try {
    const contactIds: string[] = [];
    for (let offset = 0; offset < 20000; offset += 1000) {
      const { data } = await admin
        .from("enrichment_run_items")
        .select("contact_id")
        .eq("run_id", run.id)
        .range(offset, offset + 999);
      const rows = (data as { contact_id: string }[] | null) ?? [];
      for (const r of rows) if (r.contact_id) contactIds.push(r.contact_id);
      if (rows.length < 1000) break;
    }
    const uniqIds = Array.from(new Set(contactIds));
    if (uniqIds.length === 0) return;

    const runCounts: Record<string, number> = {};
    const perSearch = new Map<string, { table: "maps_searches" | "linkedin_searches"; counts: Record<string, number> }>();

    for (let i = 0; i < uniqIds.length; i += 300) {
      const part = uniqIds.slice(i, i + 300);
      const { data } = await admin
        .from("contacts")
        .select("id, email, email_verification_status, company_email, company_phone, phone, first_name, enrichment_data")
        .eq("organization_id", run.organization_id)
        .in("id", part);
      for (const c of (data as ContactOutcomeRow[] | null) ?? []) {
        const ed = (c.enrichment_data && typeof c.enrichment_data === "object" ? c.enrichment_data : {}) as Record<string, unknown>;
        const enr = (ed.enrichment && typeof ed.enrichment === "object" ? ed.enrichment : {}) as Record<string, unknown>;
        const emailBlock = (enr.email && typeof enr.email === "object" ? enr.email : {}) as Record<string, unknown>;
        const flags = classifyContactOutcome({
          email: c.email,
          emailVerificationStatus: c.email_verification_status,
          emailKind: typeof emailBlock.kind === "string" ? emailBlock.kind : null,
          companyEmail: c.company_email,
          companyPhone: c.company_phone,
          phone: c.phone,
          firstName: c.first_name,
        });
        addOutcome(runCounts, flags);
        const mapsId = typeof ed.maps_search_id === "string" ? ed.maps_search_id : null;
        const liId = typeof ed.linkedin_search_id === "string" ? ed.linkedin_search_id : null;
        if (mapsId) {
          const g = perSearch.get(`maps_searches:${mapsId}`) ?? { table: "maps_searches" as const, counts: {} };
          addOutcome(g.counts, flags);
          perSearch.set(`maps_searches:${mapsId}`, g);
        } else if (liId) {
          const g = perSearch.get(`linkedin_searches:${liId}`) ?? { table: "linkedin_searches" as const, counts: {} };
          addOutcome(g.counts, flags);
          perSearch.set(`linkedin_searches:${liId}`, g);
        }
      }
    }

    await admin.from("enrichment_runs").update({ outcome_counts: runCounts }).eq("id", run.id);

    for (const [key, g] of perSearch) {
      const id = key.slice(key.indexOf(":") + 1);
      const { data: cur } = await admin.from(g.table).select("delivered_counts").eq("id", id).maybeSingle();
      const base = (cur as { delivered_counts?: Record<string, number> } | null)?.delivered_counts ?? {};
      const merged: Record<string, number> = { ...base };
      for (const k of ALL_COUNT_KEYS) if (g.counts[k]) merged[k] = (merged[k] ?? 0) + g.counts[k];
      await admin.from(g.table).update({ delivered_counts: merged }).eq("id", id);
    }
  } catch (e) {
    console.error("[finalizeOutcomes] failed:", e);
    // never break completion
  }
}

// Move to the next enabled phase that has work; finalize when none remain.
async function advancePhase(admin: Admin, client: ApifyClient, run: RunRow): Promise<void> {
  let phase: EnrichmentPhase = run.phase;

  for (;;) {
    if (phase === "profiles") {
      phase = "domains";
      if (run.run_domains) {
        // Re-activate domain items the profile phase backfilled a company ref to.
        // id OR slug — a profile-supplied /company/<slug> URL yields a slug only
        // (the company actor matches by slug too), and used to be stranded here.
        await admin
          .from("enrichment_run_items")
          .update({ domain_status: "pending", attempts: 0 })
          .eq("run_id", run.id)
          .eq("domain_status", "skipped")
          .is("company_domain", null)
          .or("company_id.not.is.null,company_slug.not.is.null");
        // Defensive web-lookup discovery seeding for runs created by pre-deploy
        // code: name-only, ref-less skipped items, when discovery is enabled.
        // (Primary seeding is at import time in the seeders.) Kept at the
        // transition so 'skipped'→'pending' never grows phase_total_count mid-phase.
        if (normalizeEnrichmentSettings(run.waterfall_config ?? undefined).domain_discovery_enabled) {
          await admin
            .from("enrichment_run_items")
            .update({ domain_status: "pending", attempts: 0 })
            .eq("run_id", run.id)
            .eq("domain_status", "skipped")
            .is("company_domain", null)
            .is("company_id", null)
            .is("company_slug", null)
            .not("company_name", "is", null);
        }
        const n = await countPending(admin, run.id, "domain_status");
        if (n > 0) break;
      }
      continue;
    }
    if (phase === "domains") {
      phase = "naming";
      if (run.run_naming) {
        // Seed name-less, company-named items for owner-name discovery. Runs
        // BEFORE the waterfall so a found name routes that item to pattern_mv
        // (the decision-maker → personal-email chain).
        await admin
          .from("enrichment_run_items")
          .update({ naming_status: "pending", attempts: 0 })
          .eq("run_id", run.id)
          .is("naming_status", null)
          .is("email", null)
          .is("first_name", null)
          .is("last_name", null)
          .not("company_name", "is", null);
        const n = await countPending(admin, run.id, "naming_status");
        if (n > 0) break;
      }
      continue;
    }
    if (phase === "naming") {
      phase = "waterfall";
      if (run.run_waterfall) {
        // Stamp each eligible item with its size-band method (pattern_mv /
        // site_scrape / bovi / off) from the run's config snapshot. Name-aware:
        // items the naming phase just named now route to pattern_mv.
        const n = await seedWaterfallItems(admin, run);
        if (n > 0) break;
      }
      continue;
    }
    if (phase === "waterfall") {
      phase = "activity";
      if (run.run_activity) {
        // Score posting recency for anyone with a LinkedIn profile URL.
        await admin
          .from("enrichment_run_items")
          .update({ activity_status: "pending", attempts: 0 })
          .eq("run_id", run.id)
          .not("linkedin_url", "is", null);
        const n = await countPending(admin, run.id, "activity_status");
        if (n > 0) break;
      }
      continue;
    }
    if (phase === "activity") {
      phase = "verify";
      if (run.run_verify) {
        // Verify every item that actually has an email (found this run or
        // imported with one) — the report's verifiable set. Last phase so it
        // covers waterfall-recovered addresses too.
        const n = await seedVerifyItems(admin, run);
        if (n > 0) break;
      }
      continue;
    }
    // verify → done
    phase = "complete";
    break;
  }

  if (phase === "complete") {
    await reconcileRunCost(admin, client, run);
    await finalizeOutcomes(admin, run);
    const counts = await recomputeCounters(admin, run);
    await admin
      .from("enrichment_runs")
      .update({
        status: "complete",
        phase: "complete",
        completed_at: new Date().toISOString(),
        locked_at: null,
        progress_message:
          `Emails ${counts.found_emails_count} · domains ${counts.found_domains_count}` +
          (run.run_naming ? ` · names ${counts.found_names_count}` : "") +
          (run.run_activity ? ` · activity ${counts.found_activity_count}` : "") +
          (run.run_verify ? ` · verified ${counts.found_verified_count}` : ""),
      })
      .eq("id", run.id);
    run.phase = "complete";
    run.status = "complete";
  } else {
    await admin
      .from("enrichment_runs")
      .update({ phase, progress_message: `Starting ${phase}`, locked_at: null })
      .eq("id", run.id);
    run.phase = phase;
  }
}

async function countPending(admin: Admin, runId: string, statusCol: string): Promise<number> {
  const { count } = await admin
    .from("enrichment_run_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .eq(statusCol, "pending");
  return count ?? 0;
}

async function countIn(admin: Admin, runId: string, col: string, values: string[]): Promise<number> {
  const { count } = await admin
    .from("enrichment_run_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", runId)
    .in(col, values);
  return count ?? 0;
}

interface Counters {
  phase_total_count: number;
  processed_count: number;
  found_emails_profiles_count: number;
  found_domains_count: number;
  found_emails_waterfall_count: number;
  found_emails_count: number;
  found_activity_count: number;
  found_verified_count: number;
  found_names_count: number;
}

async function recomputeCounters(admin: Admin, run: RunRow): Promise<Counters> {
  const phase = run.phase;
  let phaseTotal = 0;
  let processed = 0;
  if (phase !== "complete") {
    const col = PHASE_COLS[phase as Exclude<EnrichmentPhase, "complete">].status;
    phaseTotal = await countIn(admin, run.id, col, ["pending", "in_flight", "found", "not_found", "error"]);
    processed = await countIn(admin, run.id, col, ["found", "not_found", "error"]);
  }

  const foundProfiles = await countIn(admin, run.id, "profile_status", ["found"]);
  const foundDomains = await countIn(admin, run.id, "domain_status", ["found"]);
  const foundWaterfall = await countIn(admin, run.id, "waterfall_status", ["found"]);
  const foundActivity = await countIn(admin, run.id, "activity_status", ["found"]);
  const foundVerified = await countIn(admin, run.id, "verify_status", ["found"]);
  const foundNames = await countIn(admin, run.id, "naming_status", ["found"]);

  const { count: emailCount } = await admin
    .from("enrichment_run_items")
    .select("id", { count: "exact", head: true })
    .eq("run_id", run.id)
    .not("email", "is", null);

  const counters: Counters = {
    phase_total_count: phaseTotal,
    processed_count: processed,
    found_emails_profiles_count: foundProfiles,
    found_domains_count: foundDomains,
    found_emails_waterfall_count: foundWaterfall,
    found_emails_count: emailCount ?? 0,
    found_activity_count: foundActivity,
    found_verified_count: foundVerified,
    found_names_count: foundNames,
  };

  // Don't clobber a completed run's terminal message; just persist counts +
  // release the lease (if not already released by advance/fail).
  await admin
    .from("enrichment_runs")
    .update({ ...counters, locked_at: null })
    .eq("id", run.id);

  return counters;
}
