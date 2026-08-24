import { NextRequest, NextResponse } from "next/server";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadApifyToken } from "@/lib/apify/auth";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalOk } from "@/lib/apify/types";
import {
  buildProfileSearchInput,
  parseProfileSearchResults,
  type ProfileSearchDepth,
  type ProfileSearchLevers,
} from "@/lib/apify/sourcing/profile-search";
import type { LinkedInProspect } from "@/types/app";
import { alertActorFailure } from "@/lib/notifications/actor-failure-alert";

// GET /api/cron/run-linkedin-searches — every minute.
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
  query: { levers?: ProfileSearchLevers; depth?: ProfileSearchDepth } | null;
  target_max_results: number;
  actor: string;
  active_apify_run_id: string | null;
  active_batch_started_at: string | null;
  consecutive_failures: number;
  cost_usd: number | string;
};

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
      "id, organization_id, query, target_max_results, actor, active_apify_run_id, active_batch_started_at, consecutive_failures, cost_usd",
    )
    .maybeSingle();
  if (!claimed) return NextResponse.json({ status: "claim_failed", id: searchId });

  const row = claimed as SearchRow;

  const release = async (patch: Record<string, unknown> = {}) => {
    await admin.from("linkedin_searches").update({ locked_at: null, ...patch }).eq("id", row.id);
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
        const startedMs = row.active_batch_started_at
          ? Date.parse(row.active_batch_started_at)
          : nowMs;
        if (nowMs - startedMs > STUCK_AFTER_MS) {
          await client.abortRun(row.active_apify_run_id).catch(() => {});
          const failures = row.consecutive_failures + 1;
          await release({
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
        await release({ progress_message: "Searching LinkedIn…" });
        return NextResponse.json({ status: "running", id: row.id, apify_run_id: run.id });
      }

      if (isTerminalOk(run.status)) {
        const items = await client.getAllDatasetItems(run.defaultDatasetId, { maxItems: MAX_INGEST });
        const all: LinkedInProspect[] = parseProfileSearchResults(items);
        const prospects = all.slice(0, row.target_max_results);
        const cost =
          Number(row.cost_usd) + (typeof run.usageTotalUsd === "number" ? run.usageTotalUsd : 0);
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
        return NextResponse.json({ status: "complete", id: row.id, count: prospects.length });
      }

      // Terminal-bad (FAILED / TIMED-OUT / ABORTED).
      const failures = row.consecutive_failures + 1;
      await release({
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
        kind: "linkedin_search",
        actor: row.actor,
        error: message.slice(0, 500),
        context: { search_id: row.id },
      });
    }
    return NextResponse.json({ status: "error", id: row.id, message: message.slice(0, 200) });
  }
}
