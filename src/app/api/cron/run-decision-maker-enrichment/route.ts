import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { enrichBusiness } from "@/lib/decision-maker";
import type {
  EnrichmentInput,
  EnrichmentResult,
  ServiceType,
} from "@/lib/decision-maker";
import type { ScrapioBusiness } from "@/types/app";

// GET /api/cron/run-decision-maker-enrichment
//
// Worker tick. Picks one decision_maker_runs row in 'pending' or 'running'
// status and processes a chunk of pending result rows. Layer 1 (website
// scrape via Claude Haiku) + optional Layer 2 (Perplexity Sonar or Claude
// web_search) per business. Persists per-result enrichment fields and
// aggregates cost / progress on the run row between ticks.
//
// Designed to mirror /api/cron/run-prospect-searches:
//   - 60s maxDuration
//   - atomic claim via UPDATE...WHERE status IN ('pending','running')
//   - ~5 results per tick (≈ 3 in parallel × 2 batches)
//   - cron schedule: */1 * * * * (every minute)

export const maxDuration = 60;

const RESULTS_PER_TICK = 5;
const PARALLEL = 3;

type RunRow = {
  id: string;
  organization_id: string;
  search_id: string;
  service_type: string;
  use_layer2: boolean;
  status: string;
  total_count: number;
  processed_count: number;
  cost_usd: number | string;
  started_at: string | null;
};

type ResultRow = {
  id: string;
  google_id: string;
  business_name: string | null;
  category: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export async function GET(request: NextRequest) {
  const authError = checkCronAuth(request);
  if (authError) return authError;

  const admin = createAdminClient();

  // Find the oldest active run.
  const { data: candidates } = await admin
    .from("decision_maker_runs")
    .select(
      "id, organization_id, search_id, service_type, use_layer2, status, total_count, processed_count, cost_usd, started_at",
    )
    .in("status", ["pending", "running"])
    .order("created_at", { ascending: true })
    .limit(1);

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ status: "idle" });
  }

  const candidate = candidates[0] as RunRow;
  const claimAt = new Date().toISOString();

  // Atomic claim — only one cron instance succeeds if two run at once.
  const { data: claimedRows } = await admin
    .from("decision_maker_runs")
    .update({
      status: "running",
      started_at: candidate.started_at ?? claimAt,
    })
    .eq("id", candidate.id)
    .in("status", ["pending", "running"])
    .select(
      "id, organization_id, search_id, service_type, use_layer2, status, total_count, processed_count, cost_usd, started_at",
    );

  if (!claimedRows || claimedRows.length === 0) {
    return NextResponse.json({ status: "claim_failed", id: candidate.id });
  }
  const run = claimedRows[0] as RunRow;

  // Look up the org's API keys (with env fallback for local dev).
  const { data: org } = await admin
    .from("organizations")
    .select("anthropic_api_key, perplexity_api_key")
    .eq("id", run.organization_id)
    .maybeSingle();
  const orgKeys = org as
    | { anthropic_api_key: string | null; perplexity_api_key: string | null }
    | null;
  const anthropicKey =
    orgKeys?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || "";
  const perplexityKey =
    orgKeys?.perplexity_api_key || process.env.PERPLEXITY_API_KEY || null;

  if (!anthropicKey) {
    await admin
      .from("decision_maker_runs")
      .update({
        status: "failed",
        error_message:
          "No Anthropic API key on organization (and ANTHROPIC_API_KEY env not set)",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return NextResponse.json({
      status: "failed",
      id: run.id,
      error: "no_anthropic_key",
    });
  }

  // Fetch the parent search once so we don't N+1 against prospect_searches
  // for every result row in this tick.
  const { data: searchRow } = await admin
    .from("prospect_searches")
    .select("id, results")
    .eq("id", run.search_id)
    .maybeSingle();
  const search = searchRow as { id: string; results: ScrapioBusiness[] | null } | null;
  if (!search) {
    await admin
      .from("decision_maker_runs")
      .update({
        status: "failed",
        error_message: "Underlying prospect_search no longer exists",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return NextResponse.json({ status: "failed", id: run.id, error: "missing_search" });
  }

  const businessByGoogleId = new Map<string, ScrapioBusiness>();
  for (const b of search.results ?? []) {
    if (b.google_id) businessByGoogleId.set(b.google_id, b);
  }

  // Pull this tick's pending result rows.
  const { data: pendingResults } = await admin
    .from("decision_maker_results")
    .select("id, google_id, business_name, category")
    .eq("run_id", run.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(RESULTS_PER_TICK);

  const pending = (pendingResults as ResultRow[] | null) ?? [];

  if (pending.length === 0) {
    // No more work — finalize the run.
    await admin
      .from("decision_maker_runs")
      .update({
        status: "complete",
        completed_at: new Date().toISOString(),
        progress_message: `Enriched ${run.processed_count} of ${run.total_count}`,
      })
      .eq("id", run.id);
    return NextResponse.json({ status: "complete", id: run.id });
  }

  const serviceType: ServiceType =
    run.service_type === "events" ? "events" : "operations";

  let tickProcessed = 0;
  let tickCost = 0;

  try {
    // Process in parallel batches so a tick doesn't burn its budget waiting
    // serially for slow websites.
    for (const batch of chunk(pending, PARALLEL)) {
      const settled = await Promise.allSettled(
        batch.map(async (row) => {
          const business = businessByGoogleId.get(row.google_id);
          const input: EnrichmentInput = {
            business_name: business?.name || row.business_name || "",
            website: business?.website || null,
            category: row.category || business?.types || null,
            city: business?.city || null,
            state: business?.state || null,
            generic_email: business?.email || null,
          };
          const result = await enrichBusiness(input, {
            serviceType,
            useLayer2: run.use_layer2,
            anthropicKey,
            perplexityKey: perplexityKey ?? undefined,
          });
          return { row, result };
        }),
      );

      for (const outcome of settled) {
        if (outcome.status === "fulfilled") {
          const { row, result } = outcome.value;
          await admin
            .from("decision_maker_results")
            .update({
              first_name: result.first_name,
              last_name: result.last_name,
              title: result.title,
              personal_email: result.personal_email,
              other_emails: result.other_emails,
              enrichment_source: result.enrichment_source,
              enrichment_notes: result.enrichment_notes,
              status: result.status,
              cost_usd: result.cost_usd,
            })
            .eq("id", row.id);
          tickProcessed++;
          tickCost += result.cost_usd;
        } else {
          // Promise itself rejected — stamp the row as error so the run
          // can finish even if one lead blew up unexpectedly.
          const errMsg =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason);
          // Best-effort: try to find the row by index in the batch.
          // Settled order matches batch order, so we can recover the row.
          const idx = settled.indexOf(outcome);
          const row = batch[idx];
          if (row) {
            await admin
              .from("decision_maker_results")
              .update({
                status: "error",
                enrichment_notes: `Worker error: ${errMsg}`,
              })
              .eq("id", row.id);
            tickProcessed++;
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[cron/run-decision-maker-enrichment] run ${run.id} threw:`,
      err,
    );
    await admin
      .from("decision_maker_runs")
      .update({
        status: "failed",
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return NextResponse.json({
      status: "failed",
      id: run.id,
      error: message,
    });
  }

  const newProcessed = run.processed_count + tickProcessed;
  const prevCost = Number(run.cost_usd) || 0;
  const newCost = prevCost + tickCost;
  const isDone = newProcessed >= run.total_count;
  const progress = isDone
    ? `Enriched ${newProcessed} of ${run.total_count}`
    : `Enriched ${newProcessed} of ${run.total_count} so far`;

  await admin
    .from("decision_maker_runs")
    .update({
      processed_count: newProcessed,
      cost_usd: newCost.toFixed(6),
      progress_message: progress,
      status: isDone ? "complete" : "running",
      completed_at: isDone ? new Date().toISOString() : null,
    })
    .eq("id", run.id);

  return NextResponse.json({
    status: isDone ? "complete" : "running",
    id: run.id,
    processed_this_tick: tickProcessed,
    total_processed: newProcessed,
    target: run.total_count,
  });
}
