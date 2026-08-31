import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadApifyToken, loadEnrichmentSettings } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalOk } from "@/lib/apify/types";
import {
  buildMapsSearchInput,
  buildMapsSearchInputForArea,
  coerceMapsAreas,
  ingestAreaResult,
  parseMapsSearchResults,
  perAreaMaxItems,
  type MapsArea,
  type MapsSearchLevers,
} from "@/lib/apify/sourcing/maps-search";
import type { MapsPlace } from "@/types/app";
import { importMapsPlaces } from "@/lib/apify/import-maps-places";
import { enqueueEnrichment } from "@/lib/apify/enqueue-enrichment";
import { alertActorFailure } from "@/lib/notifications/actor-failure-alert";
import { loadBuyerRunCeiling, capRunCharge } from "@/lib/tokens/billing";

// GET /api/cron/run-maps-searches — every minute. The Google-Maps twin of
// run-linkedin-searches: one tick advances one search under a 90s lease, either
// STARTING the compass~google-maps-extractor actor or POLLING the in-flight run.
// A single run returns up to target_max_results, so the lifecycle is start →
// poll → (SUCCEEDED) ingest the whole dataset → complete. The lease + "call
// Apify, then persist the run id" ordering keep a crash from starting a second
// paid run.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEASE_MS = 90_000;
const APIFY_TIMEOUT_SEC = 1200;
const STUCK_AFTER_MS = 20 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INGEST = 5000;

type SearchRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  saved_count: number | null;
  query: {
    levers?: MapsSearchLevers;
    addons?: unknown;
  } | null;
  target_max_results: number;
  actor: string;
  active_apify_run_id: string | null;
  active_apify_dataset_id: string | null;
  active_batch_started_at: string | null;
  consecutive_failures: number;
  cost_usd: number | string;
  // Multi-region fan-out (Phase 2): the running de-duplicated union across areas.
  // The area cursor (area_index) is read lazily in the multi-area handler, NOT
  // here — so this hot-path SELECT never references a column that may not exist
  // until migration 00094 is applied (keeps the single-area path deploy-safe
  // regardless of migration timing).
  results: MapsPlace[] | null;
};

// Resolve a user to attribute the auto-run to: the search's creator, else the
// org owner (same fallback as run-linkedin-searches). Null when neither exists.
async function resolveAutoRunUserId(
  admin: ReturnType<typeof createAdminClient>,
  row: SearchRow,
): Promise<string | null> {
  if (row.created_by) return row.created_by;
  const { data: owner } = await admin
    .from("profiles")
    .select("id")
    .eq("organization_id", row.organization_id)
    .eq("role", "owner")
    .limit(1)
    .maybeSingle();
  return (owner as { id: string } | null)?.id ?? null;
}

// Best-effort auto-import of a completed search's places into Contacts, then
// start enrichment. Gated on the org's auto_run_after_search kill-switch. Never
// throws — sourcing is already saved; a failure here degrades to the manual
// "Import to Contacts" path. Returns a short progress note.
async function autoImportAndEnrich(
  admin: ReturnType<typeof createAdminClient>,
  row: SearchRow,
  places: MapsPlace[],
): Promise<string | null> {
  try {
    const settings = await loadEnrichmentSettings(admin, row.organization_id);
    if (!settings.auto_run_after_search) return null;
    const userId = await resolveAutoRunUserId(admin, row);
    if (!userId) return "auto-import skipped — no owner to attribute the run to";

    const imported = await importMapsPlaces(admin, {
      organizationId: row.organization_id,
      search: { id: row.id, saved_count: row.saved_count, query: row.query },
      places,
    });
    if (imported.insertedIds.length === 0) {
      return imported.skippedDuplicates > 0
        ? `Imported 0 · ${imported.skippedDuplicates} already in Contacts`
        : "Imported 0 businesses";
    }
    const enq = await enqueueEnrichment(admin, {
      organizationId: row.organization_id,
      userId,
      contactIds: imported.insertedIds,
    });
    const tail =
      enq.status === "started"
        ? "enrichment started"
        : enq.status === "queued"
          ? "enrichment queued"
          : `enrichment skipped (${enq.reason})`;
    return `Imported ${imported.inserted} to Contacts · ${tail}`;
  } catch (err) {
    console.error("[run-maps-searches] auto-import failed:", err);
    return "auto-import failed — import manually from the results table";
  }
}

// Read the fan-out cursor lazily (only for multi-region searches). Kept out of
// the hot-path claim SELECT so single-area searches never touch this column,
// which may not exist until migration 00094 is applied. If the column IS missing
// while a multi-area row somehow exists (migration applied AFTER the route that
// writes `areas` — an order we flag against), this throws a clear error; the GET
// handler's catch then fails the search safely WITHOUT starting any paid run.
async function readAreaIndex(
  admin: ReturnType<typeof createAdminClient>,
  id: string,
): Promise<number> {
  const { data, error } = await admin
    .from("maps_searches")
    .select("area_index")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new Error(
      `maps_searches.area_index missing — apply migration 00094 before running multi-region searches (${error.message})`,
    );
  }
  const n = (data as { area_index?: number } | null)?.area_index;
  return typeof n === "number" && n >= 0 ? n : 0;
}

// Advance one tick of a MULTI-REGION search: scrape one actor run per area,
// sequentially, accumulating a de-duplicated union of places until every area is
// done, then slice to target_max_results and complete. `area_index` is the
// cursor into `areas`; `results` holds the running accumulation between areas.
// The lease + "start Apify, then persist the run id" ordering (owned by the GET
// handler's claim + `release`) still guard against overlapping paid runs.
async function advanceMultiAreaSearch(
  admin: ReturnType<typeof createAdminClient>,
  client: ApifyClient,
  row: SearchRow,
  areas: MapsArea[],
  release: (patch?: Record<string, unknown>) => Promise<void>,
  nowMs: number,
): Promise<NextResponse> {
  const areaCount = areas.length;
  const areaIndex = Math.max(0, Math.min(await readAreaIndex(admin, row.id), areaCount));
  const accumulated: MapsPlace[] = Array.isArray(row.results) ? row.results : [];
  const levers = row.query?.levers ?? {};
  const addUsage = (usd: number | null | undefined) =>
    Number(row.cost_usd) + (typeof usd === "number" ? usd : 0);

  // (A) A run is in flight for the current area → poll it.
  if (row.active_apify_run_id) {
    const run = await client.getRun(row.active_apify_run_id);

    if (isInProgress(run.status)) {
      const startedMs = row.active_batch_started_at ? Date.parse(row.active_batch_started_at) : nowMs;
      if (nowMs - startedMs > STUCK_AFTER_MS) {
        await client.abortRun(row.active_apify_run_id).catch(() => {});
        const failures = row.consecutive_failures + 1;
        await release({
          cost_usd: addUsage(run.usageTotalUsd),
          active_apify_run_id: null,
          active_apify_dataset_id: null,
          active_batch_started_at: null,
          consecutive_failures: failures,
          progress_message: `Area ${areaIndex + 1} timed out, retrying`,
          ...(failures >= MAX_CONSECUTIVE_FAILURES
            ? { status: "failed", error_message: "Search timed out repeatedly", completed_at: new Date().toISOString() }
            : {}),
        });
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          await alertActorFailure(admin, {
            kind: "maps_search",
            actor: row.actor,
            error: "Search timed out repeatedly",
            context: { search_id: row.id, area_index: areaIndex },
          });
        }
        return NextResponse.json({ status: "aborted_stuck", id: row.id, area: areaIndex + 1 });
      }
      // Live progress: accumulated (prior areas) + this area's dataset so far.
      const scraped = await client
        .getDatasetItemCount(run.defaultDatasetId)
        .then((n) => n ?? 0)
        .catch(() => 0);
      const soFar = Math.min(accumulated.length + scraped, row.target_max_results);
      await release({
        result_count: soFar,
        progress_message: `Searching area ${areaIndex + 1} of ${areaCount}… ${soFar} found`,
      });
      return NextResponse.json({
        status: "running",
        id: row.id,
        apify_run_id: run.id,
        area: areaIndex + 1,
        of: areaCount,
        scraped: soFar,
      });
    }

    if (isTerminalOk(run.status)) {
      const items = await client.getAllDatasetItems(run.defaultDatasetId, { maxItems: MAX_INGEST });
      const incoming = parseMapsSearchResults(items);
      const step = ingestAreaResult({
        areaIndex,
        areaCount,
        accumulated,
        incoming,
        target: row.target_max_results,
      });
      const cost = addUsage(run.usageTotalUsd);

      if (!step.done) {
        // More areas remain → persist the accumulation + advance the cursor,
        // clear run tracking, stay `running`. Next tick starts the next area.
        await release({
          results: step.accumulated,
          result_count: Math.min(step.accumulated.length, row.target_max_results),
          area_index: step.nextAreaIndex,
          cost_usd: cost,
          active_apify_run_id: null,
          active_apify_dataset_id: null,
          active_batch_started_at: null,
          consecutive_failures: 0,
          progress_message: `Area ${areaIndex + 1} of ${areaCount} done · ${step.accumulated.length} so far`,
        });
        return NextResponse.json({
          status: "area_done",
          id: row.id,
          area: areaIndex + 1,
          of: areaCount,
          accumulated: step.accumulated.length,
        });
      }

      // Last area done → finalize the sliced union, then auto-import + enrich.
      const places = step.finalResults ?? step.accumulated;
      await release({
        status: "complete",
        results: places,
        result_count: places.length,
        area_index: step.nextAreaIndex,
        truncated: Boolean(step.truncated),
        cost_usd: cost,
        active_apify_run_id: null,
        active_apify_dataset_id: null,
        active_batch_started_at: null,
        consecutive_failures: 0,
        progress_message: `Found ${places.length} ${places.length === 1 ? "business" : "businesses"} across ${areaCount} areas`,
        completed_at: new Date().toISOString(),
      });
      const note = await autoImportAndEnrich(admin, { ...row, results: places }, places);
      if (note) {
        await admin
          .from("maps_searches")
          .update({ progress_message: `Found ${places.length} · ${note}` })
          .eq("id", row.id);
      }
      return NextResponse.json({ status: "complete", id: row.id, count: places.length, areas: areaCount, auto: note });
    }

    // Terminal-bad → retry the SAME area (cursor unchanged), clear run tracking.
    const failures = row.consecutive_failures + 1;
    await release({
      cost_usd: addUsage(run.usageTotalUsd),
      active_apify_run_id: null,
      active_apify_dataset_id: null,
      active_batch_started_at: null,
      consecutive_failures: failures,
      progress_message: `Area ${areaIndex + 1} retrying after: ${run.statusMessage ?? run.status}`,
      ...(failures >= MAX_CONSECUTIVE_FAILURES
        ? { status: "failed", error_message: run.statusMessage ?? `Actor run ${run.status}`, completed_at: new Date().toISOString() }
        : {}),
    });
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await alertActorFailure(admin, {
        kind: "maps_search",
        actor: row.actor,
        error: run.statusMessage ?? `Actor run ${run.status}`,
        context: { search_id: row.id, area_index: areaIndex },
      });
    }
    return NextResponse.json({ status: "run_failed", id: row.id, area: areaIndex + 1, apify_status: run.status });
  }

  // (B) No run in flight → start the current area. Cursor already past the end
  // (shouldn't happen — completion sets `complete`) → finalize defensively.
  if (areaIndex >= areaCount) {
    const places = accumulated.slice(0, row.target_max_results);
    await release({
      status: "complete",
      results: places,
      result_count: places.length,
      progress_message: `Found ${places.length} ${places.length === 1 ? "business" : "businesses"}`,
      completed_at: new Date().toISOString(),
    });
    return NextResponse.json({ status: "complete", id: row.id, count: places.length, finalized: "from_accumulated" });
  }
  // Clamp the DB target defensively (the creation route caps 1..5000, but the
  // cron must not trust a value another writer could store larger). SPEND-03.
  const clampedTarget = Math.min(row.target_max_results, 5000);
  const input = buildMapsSearchInputForArea(levers, areas[areaIndex], {
    maxItems: perAreaMaxItems(clampedTarget, areaCount),
  });
  // Hard per-run charge cap (~2× place+filters, +leads add-on if on). Apify aborts
  // the area run at this $, bounding a per-place-cap surprise (the $14 incident). SPEND-01.
  const capPerPlace = 0.012 + (levers.linkedinLeads ? 0.05 : 0);
  // Buyer-run only: the owner's max_charge_per_run_usd ceiling (null for agency).
  const chargeCeiling = await loadBuyerRunCeiling(admin, row.organization_id);
  const run = await client.startActorRun(row.actor, input, {
    timeoutSec: APIFY_TIMEOUT_SEC,
    maxTotalChargeUsd: capRunCharge(Math.max(1, perAreaMaxItems(clampedTarget, areaCount) * capPerPlace), chargeCeiling),
  });
  // Claim the active-run slot with a CAS guard (mirrors run-apify-enrichment):
  // only persist this run id if none is set. An overlapping tick (a >90s local
  // tick vs a prod tick, SPEND-15) or a racing retry (SPEND-14) that already
  // claimed the slot means this run would bill orphaned, so abort it best-effort
  // and yield rather than leaving a second paid run live.
  const { data: claimedSlot } = await admin
    .from("maps_searches")
    .update({
      locked_at: null,
      active_apify_run_id: run.id,
      active_apify_dataset_id: run.defaultDatasetId,
      active_batch_started_at: new Date().toISOString(),
      progress_message: `Searching area ${areaIndex + 1} of ${areaCount}…`,
    })
    .eq("id", row.id)
    .is("active_apify_run_id", null)
    .select("id");
  if (!claimedSlot || claimedSlot.length === 0) {
    await client.abortRun(run.id).catch(() => {});
    return NextResponse.json({ status: "lost_race", id: row.id, area: areaIndex + 1 });
  }
  return NextResponse.json({
    status: "started",
    id: row.id,
    apify_run_id: run.id,
    area: areaIndex + 1,
    of: areaCount,
  });
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const nowMs = Date.now();
  const leaseCutoff = new Date(nowMs - LEASE_MS).toISOString();

  const { data: candidate } = await admin
    .from("maps_searches")
    .select("id")
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return NextResponse.json({ status: "idle" });

  const searchId = (candidate as { id: string }).id;

  // Lease claim: take it only if unlocked or the lease expired. The paid actor
  // makes overlapping ticks unacceptable.
  const { data: claimed } = await admin
    .from("maps_searches")
    .update({
      status: "running",
      started_at: new Date(nowMs).toISOString(),
      locked_at: new Date(nowMs).toISOString(),
    })
    .eq("id", searchId)
    .in("status", ["pending", "running"])
    .or(`locked_at.is.null,locked_at.lt.${leaseCutoff}`)
    .select(
      "id, organization_id, created_by, saved_count, query, target_max_results, actor, active_apify_run_id, active_apify_dataset_id, active_batch_started_at, consecutive_failures, cost_usd, results",
    )
    .maybeSingle();
  if (!claimed) return NextResponse.json({ status: "claim_failed", id: searchId });

  const row = claimed as SearchRow;

  const release = async (patch: Record<string, unknown> = {}) => {
    await admin.from("maps_searches").update({ locked_at: null, ...patch }).eq("id", row.id);
  };

  // Hoisted so the outer catch (SPEND-10) can abort an in-flight run when a
  // transient poll error trips the breaker.
  let client: ApifyClient | null = null;

  try {
    const token = await loadApifyToken(admin, row.organization_id);
    if (!token) {
      await release({
        status: "failed",
        error_message: "Apify API token not set",
        completed_at: new Date().toISOString(),
      });
      return NextResponse.json({ status: "failed", id: row.id, reason: "no_token" });
    }
    client = new ApifyClient(token);

    // Multi-region search → fan out one actor run per structured area,
    // sequentially. Rows with only a free-text locationQuery (no `areas`) fall
    // through to the unchanged single-run path below.
    const areas = coerceMapsAreas(row.query?.levers?.areas);
    if (areas.length > 0) {
      return await advanceMultiAreaSearch(admin, client, row, areas, release, nowMs);
    }

    // (A) A run is in flight → poll it.
    if (row.active_apify_run_id) {
      const run = await client.getRun(row.active_apify_run_id);

      if (isInProgress(run.status)) {
        const startedMs = row.active_batch_started_at ? Date.parse(row.active_batch_started_at) : nowMs;
        if (nowMs - startedMs > STUCK_AFTER_MS) {
          await client.abortRun(row.active_apify_run_id).catch(() => {});
          const failures = row.consecutive_failures + 1;
          await release({
            cost_usd:
              Number(row.cost_usd) + (typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : 0),
            active_apify_run_id: null,
            active_apify_dataset_id: null,
            active_batch_started_at: null,
            consecutive_failures: failures,
            progress_message: "Search timed out, retrying",
            ...(failures >= MAX_CONSECUTIVE_FAILURES
              ? {
                  status: "failed",
                  error_message: "Search timed out repeatedly",
                  completed_at: new Date().toISOString(),
                }
              : {}),
          });
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            await alertActorFailure(admin, {
              kind: "maps_search",
              actor: row.actor,
              error: "Search timed out repeatedly",
              context: { search_id: row.id },
            });
          }
          return NextResponse.json({ status: "aborted_stuck", id: row.id });
        }
        // Live progress: the run object carries no item count, so read the
        // dataset's itemCount (updates as the actor pushes places). Progress-only:
        // a transient failure must not fail the poll tick.
        const scraped = await client
          .getDatasetItemCount(run.defaultDatasetId)
          .then((n) => n ?? 0)
          .catch(() => 0);
        const soFar = Math.min(scraped, row.target_max_results);
        await release({
          result_count: soFar,
          progress_message: soFar > 0 ? `Finding businesses… ${soFar} found` : "Searching Google Maps…",
        });
        return NextResponse.json({ status: "running", id: row.id, apify_run_id: run.id, scraped: soFar });
      }

      if (isTerminalOk(run.status)) {
        const items = await client.getAllDatasetItems(run.defaultDatasetId, { maxItems: MAX_INGEST });
        const all: MapsPlace[] = parseMapsSearchResults(items);
        const places = all.slice(0, row.target_max_results);
        const cost =
          Number(row.cost_usd) + (typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : 0);
        // Persist results + mark complete FIRST (never lose sourcing), then
        // best-effort auto-import + enrich (which bumps saved_count and owns the
        // progress_message tail).
        await release({
          status: "complete",
          results: places,
          result_count: places.length,
          truncated: all.length > row.target_max_results,
          cost_usd: cost,
          active_apify_run_id: null,
          active_apify_dataset_id: null,
          active_batch_started_at: null,
          consecutive_failures: 0,
          progress_message: `Found ${places.length} ${places.length === 1 ? "business" : "businesses"}`,
          completed_at: new Date().toISOString(),
        });
        const note = await autoImportAndEnrich(admin, row, places);
        if (note) {
          await admin
            .from("maps_searches")
            .update({ progress_message: `Found ${places.length} · ${note}` })
            .eq("id", row.id);
        }
        return NextResponse.json({ status: "complete", id: row.id, count: places.length, auto: note });
      }

      // Terminal-bad (FAILED / TIMED-OUT / ABORTED).
      const failures = row.consecutive_failures + 1;
      await release({
        cost_usd:
          Number(row.cost_usd) + (typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : 0),
        active_apify_run_id: null,
        active_apify_dataset_id: null,
        active_batch_started_at: null,
        consecutive_failures: failures,
        progress_message: `Retrying after: ${run.statusMessage ?? run.status}`,
        ...(failures >= MAX_CONSECUTIVE_FAILURES
          ? {
              status: "failed",
              error_message: run.statusMessage ?? `Actor run ${run.status}`,
              completed_at: new Date().toISOString(),
            }
          : {}),
      });
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        await alertActorFailure(admin, {
          kind: "maps_search",
          actor: row.actor,
          error: run.statusMessage ?? `Actor run ${run.status}`,
          context: { search_id: row.id },
        });
      }
      return NextResponse.json({ status: "run_failed", id: row.id, apify_status: run.status });
    }

    // (B) No run in flight → start one. Call Apify first, then persist the run id.
    const clampedTarget = Math.min(row.target_max_results, 5000); // SPEND-03
    const legacyLevers = (row.query?.levers ?? {}) as MapsSearchLevers;
    const input = buildMapsSearchInput(legacyLevers, {
      maxItems: clampedTarget,
    });
    // Hard per-run charge cap (~2× place+filters, +leads if on). Apify aborts at
    // this $, bounding a per-place-cap surprise. SPEND-01.
    const capPerPlace = 0.012 + (legacyLevers.linkedinLeads ? 0.05 : 0);
    // Buyer-run only: the owner's max_charge_per_run_usd ceiling (null for agency).
    const chargeCeiling = await loadBuyerRunCeiling(admin, row.organization_id);
    const run = await client.startActorRun(row.actor, input, {
      timeoutSec: APIFY_TIMEOUT_SEC,
      maxTotalChargeUsd: capRunCharge(Math.max(1, clampedTarget * capPerPlace), chargeCeiling),
    });
    // Claim the active-run slot with a CAS guard (mirrors run-apify-enrichment):
    // only persist this run id if none is set. An overlapping tick (SPEND-15) or
    // a racing retry (SPEND-14) that already claimed it means this run would bill
    // orphaned, so abort it best-effort and yield instead of persisting a 2nd id.
    const { data: claimedSlot } = await admin
      .from("maps_searches")
      .update({
        locked_at: null,
        active_apify_run_id: run.id,
        active_apify_dataset_id: run.defaultDatasetId,
        active_batch_started_at: new Date().toISOString(),
        progress_message: "Search queued on Apify…",
      })
      .eq("id", row.id)
      .is("active_apify_run_id", null)
      .select("id");
    if (!claimedSlot || claimedSlot.length === 0) {
      await client.abortRun(run.id).catch(() => {});
      return NextResponse.json({ status: "lost_race", id: row.id });
    }
    return NextResponse.json({ status: "started", id: row.id, apify_run_id: run.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failures = row.consecutive_failures + 1;
    // SPEND-10: a transient poll error (e.g. getRun threw) that trips the breaker
    // parks the search failed, leaving the in-flight actor to keep billing to its
    // 20-min timeout with nobody left to poll or ingest it. Abort it best-effort
    // before marking failed (only when a run id is actually known).
    if (failures >= MAX_CONSECUTIVE_FAILURES && row.active_apify_run_id && client) {
      await client.abortRun(row.active_apify_run_id).catch(() => {});
    }
    await release({
      consecutive_failures: failures,
      progress_message: `Retrying after error: ${message.slice(0, 200)}`,
      ...(failures >= MAX_CONSECUTIVE_FAILURES
        ? { status: "failed", error_message: message.slice(0, 500), completed_at: new Date().toISOString() }
        : {}),
    });
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await alertActorFailure(admin, {
        kind: "maps_search",
        actor: row.actor,
        error: message.slice(0, 500),
        context: { search_id: row.id },
      });
    }
    return NextResponse.json({ status: "error", id: row.id, message: message.slice(0, 200) });
  }
}
