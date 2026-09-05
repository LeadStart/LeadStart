import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadApifyToken, loadEnrichmentSettings } from "@/lib/apify/auth";
import { loadBuyerRunCeiling, capRunCharge } from "@/lib/tokens/billing";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalOk } from "@/lib/apify/types";
import {
  buildProfileSearchInput,
  parseProfileSearchResults,
  type ProfileSearchDepth,
  type ProfileSearchLevers,
} from "@/lib/apify/sourcing/profile-search";
import type { LinkedInProspect } from "@/types/app";
import { importLinkedInProspects } from "@/lib/apify/import-prospects";
import { enqueueEnrichment } from "@/lib/apify/enqueue-enrichment";
import { alertActorFailure } from "@/lib/notifications/actor-failure-alert";

// GET /api/cron/run-linkedin-searches: every minute.
//
// One tick advances one search: claim it under a 90s lease, then either START
// the actor (if no run is in flight) or POLL the in-flight run. A single actor
// run returns up to target_max_results, so the lifecycle is start → poll →
// (SUCCEEDED) ingest the whole dataset → complete. No across-tick pagination
// (unlike the synchronous Scrap.io worker). The lease + "call Apify, then
// persist the run id" ordering keep a crash from starting a second paid run.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEASE_MS = 90_000;
const APIFY_TIMEOUT_SEC = 1200;
const STUCK_AFTER_MS = 20 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_INGEST = 2500;

type SearchRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  saved_count: number | null;
  query: {
    levers?: ProfileSearchLevers;
    depth?: ProfileSearchDepth;
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
// org owner (same fallback as drain-enrichment-queue). Null when neither exists.
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

// Best-effort auto-import of a completed search's sourced people into Contacts,
// then start enrichment. Gated on the org's auto_run_after_search kill-switch.
// Never throws: sourcing is already saved; a failure here degrades to the
// manual "Import to Contacts" path. Returns a short progress note.
async function autoImportAndEnrich(
  admin: ReturnType<typeof createAdminClient>,
  row: SearchRow,
  prospects: LinkedInProspect[],
): Promise<string | null> {
  try {
    const settings = await loadEnrichmentSettings(admin, row.organization_id);
    if (!settings.auto_run_after_search) return null;
    const userId = await resolveAutoRunUserId(admin, row);
    if (!userId) return "auto-import skipped: no owner to attribute the run to";

    const imported = await importLinkedInProspects(admin, {
      organizationId: row.organization_id,
      // saved_count is bumped inside the helper; pass what we have (0 for a fresh
      // search), the manual path may add more later.
      search: { id: row.id, saved_count: row.saved_count, query: row.query },
      prospects,
    });
    if (imported.insertedIds.length === 0) {
      return imported.skippedDuplicates > 0
        ? `Imported 0 · ${imported.skippedDuplicates} already in Contacts`
        : "Imported 0 people";
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
    console.error("[run-linkedin-searches] auto-import failed:", err);
    return "auto-import failed: import manually from the results table";
  }
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();
  const nowMs = Date.now();
  const leaseCutoff = new Date(nowMs - LEASE_MS).toISOString();

  const { data: candidate } = await admin
    .from("linkedin_searches")
    .select("id")
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!candidate) return NextResponse.json({ status: "idle" });

  const searchId = (candidate as { id: string }).id;

  // Lease claim: take it only if unlocked or the lease expired. The paid actor
  // makes overlapping ticks unacceptable, so this is stricter than the Scrap.io
  // worker's lease-less CAS.
  const { data: claimed } = await admin
    .from("linkedin_searches")
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
    await admin.from("linkedin_searches").update({ locked_at: null, ...patch }).eq("id", row.id);
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

    // (A) A run is in flight → poll it.
    if (row.active_apify_run_id) {
      const run = await client.getRun(row.active_apify_run_id);

      if (isInProgress(run.status)) {
        const startedMs = row.active_batch_started_at
          ? Date.parse(row.active_batch_started_at)
          : nowMs;
        if (nowMs - startedMs > STUCK_AFTER_MS) {
          await client.abortRun(row.active_apify_run_id).catch(() => {});
          const failures = row.consecutive_failures + 1;
          await release({
            // A stuck+aborted actor still incurred charges: record what it
            // accrued (partial) so spend isn't hidden.
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
              kind: "linkedin_search",
              actor: row.actor,
              error: "Search timed out repeatedly",
              context: { search_id: row.id },
            });
          }
          return NextResponse.json({ status: "aborted_stuck", id: row.id });
        }
        // Surface live sourcing progress. The run object exposes no item count
        // (its stats are runtime/memory/CPU only), so read the run's dataset,
        // itemCount updates as the actor pushes profiles (per profile in Full
        // modes, per 25-result search page in Short mode). Progress-only read:
        // a transient failure must not fail the poll tick.
        const scraped = await client
          .getDatasetItemCount(run.defaultDatasetId)
          .then((n) => n ?? 0)
          .catch(() => 0);
        const soFar = Math.min(scraped, row.target_max_results);
        await release({
          result_count: soFar,
          progress_message: soFar > 0 ? `Sourcing profiles… ${soFar} found` : "Searching LinkedIn…",
        });
        return NextResponse.json({ status: "running", id: row.id, apify_run_id: run.id, scraped: soFar });
      }

      if (isTerminalOk(run.status)) {
        const items = await client.getAllDatasetItems(run.defaultDatasetId, { maxItems: MAX_INGEST });
        const all: LinkedInProspect[] = parseProfileSearchResults(items);
        const prospects = all.slice(0, row.target_max_results);
        const cost =
          Number(row.cost_usd) + (typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : 0);
        // Persist the sourced results + mark complete FIRST (never lose sourcing),
        // then best-effort auto-import + enrich. autoImportAndEnrich also bumps
        // saved_count, so clear active_apify_run_id here and let it own the
        // progress_message tail.
        await release({
          status: "complete",
          results: prospects,
          result_count: prospects.length,
          truncated: all.length > row.target_max_results,
          cost_usd: cost,
          active_apify_run_id: null,
          active_apify_dataset_id: null,
          active_batch_started_at: null,
          consecutive_failures: 0,
          progress_message: `Found ${prospects.length} ${prospects.length === 1 ? "person" : "people"}`,
          completed_at: new Date().toISOString(),
        });
        const note = await autoImportAndEnrich(admin, row, prospects);
        if (note) {
          await admin
            .from("linkedin_searches")
            .update({ progress_message: `Found ${prospects.length} · ${note}` })
            .eq("id", row.id);
        }
        return NextResponse.json({ status: "complete", id: row.id, count: prospects.length, auto: note });
      }

      // Terminal-bad (FAILED / TIMED-OUT / ABORTED).
      const failures = row.consecutive_failures + 1;
      await release({
        // A failed/aborted actor still cost money (per-event billing): record
        // the real charge so it isn't dropped from the search's cost.
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
          kind: "linkedin_search",
          actor: row.actor,
          error: run.statusMessage ?? `Actor run ${run.status}`,
          context: { search_id: row.id },
        });
      }
      return NextResponse.json({ status: "run_failed", id: row.id, apify_status: run.status });
    }

    // (B) No run in flight → start one. Call Apify first, then persist the run
    // id, so a crash leaves at most one orphan run (never an ambiguous placeholder).
    const input = buildProfileSearchInput(row.query?.levers ?? {}, {
      depth: row.query?.depth ?? "short",
      maxItems: row.target_max_results,
    });
    // Hard per-run charge cap (~$0.05/profile ceiling; real ~$0.014 + the $0.10/page
    // floor). Apify aborts at this $, bounding the deep-search page/segment
    // blow-up even beyond the per-segment page clamp. SPEND-01.
    // Buyer-run only: the owner's max_charge_per_run_usd ceiling (null for agency).
    const chargeCeiling = await loadBuyerRunCeiling(admin, row.organization_id);
    const run = await client.startActorRun(row.actor, input, {
      timeoutSec: APIFY_TIMEOUT_SEC,
      maxTotalChargeUsd: capRunCharge(Math.max(2, row.target_max_results * 0.05), chargeCeiling),
    });
    // Claim the active-run slot with a CAS guard (mirrors run-apify-enrichment):
    // only persist this run id if none is set. An overlapping tick (a >90s local
    // tick vs a prod tick, SPEND-15) or a racing retry (SPEND-14) that already
    // claimed it means this run would bill orphaned, so abort it best-effort and
    // yield instead of persisting a second id.
    const { data: claimedSlot } = await admin
      .from("linkedin_searches")
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
        kind: "linkedin_search",
        actor: row.actor,
        error: message.slice(0, 500),
        context: { search_id: row.id },
      });
    }
    return NextResponse.json({ status: "error", id: row.id, message: message.slice(0, 200) });
  }
}
