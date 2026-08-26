import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadApifyToken, loadEnrichmentSettings } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalOk } from "@/lib/apify/types";
import {
  buildMapsSearchInput,
  parseMapsSearchResults,
  type MapsSearchLevers,
} from "@/lib/apify/sourcing/maps-search";
import type { MapsPlace } from "@/types/app";
import { importMapsPlaces } from "@/lib/apify/import-maps-places";
import { enqueueEnrichment } from "@/lib/apify/enqueue-enrichment";
import { alertActorFailure } from "@/lib/notifications/actor-failure-alert";

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
  active_batch_started_at: string | null;
  consecutive_failures: number;
  cost_usd: number | string;
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
      "id, organization_id, created_by, saved_count, query, target_max_results, actor, active_apify_run_id, active_batch_started_at, consecutive_failures, cost_usd",
    )
    .maybeSingle();
  if (!claimed) return NextResponse.json({ status: "claim_failed", id: searchId });

  const row = claimed as SearchRow;

  const release = async (patch: Record<string, unknown> = {}) => {
    await admin.from("maps_searches").update({ locked_at: null, ...patch }).eq("id", row.id);
  };

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
    const client = new ApifyClient(token);

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
    const input = buildMapsSearchInput(row.query?.levers ?? {}, {
      maxItems: row.target_max_results,
    });
    const run = await client.startActorRun(row.actor, input, { timeoutSec: APIFY_TIMEOUT_SEC });
    await release({
      active_apify_run_id: run.id,
      active_apify_dataset_id: run.defaultDatasetId,
      active_batch_started_at: new Date().toISOString(),
      progress_message: "Search queued on Apify…",
    });
    return NextResponse.json({ status: "started", id: row.id, apify_run_id: run.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const failures = row.consecutive_failures + 1;
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
