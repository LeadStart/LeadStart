import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/security/cron-auth";
import { ApifyClient } from "@/lib/apify/client";
import { isInProgress, isTerminalBad, isTerminalOk } from "@/lib/apify/types";
import { loadApifyToken } from "@/lib/apify/auth";
import { extractCompanyId, extractCompanySlug } from "@/lib/apify/domain";
import { getProvider } from "@/lib/apify/providers";
import type { PhaseResult, ProviderItem } from "@/lib/apify/providers/types";
import { sanitizeFoundEmail } from "@/lib/apify/email-sanity";
import { ENRICH_RUN_COLUMNS, ENRICH_ITEM_WORK_COLUMNS } from "@/lib/apify/columns";
import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  WATERFALL_LEAD_COST_USD,
  ACTIVITY_COST_USD,
} from "@/lib/apify/pricing";
import type { EmailProviderId, EnrichmentPhase } from "@/types/app";

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
  profile_actor: string;
  domain_actor: string;
  waterfall_actor: string | null;
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
  profile_status: string;
  profile_apify_run_id: string | null;
  domain_status: string;
  domain_apify_run_id: string | null;
  waterfall_status: string | null;
  waterfall_apify_run_id: string | null;
};

const PHASE_COLS: Record<
  Exclude<EnrichmentPhase, "complete">,
  { status: string; runId: string; notes: string }
> = {
  profiles: { status: "profile_status", runId: "profile_apify_run_id", notes: "profile_notes" },
  domains: { status: "domain_status", runId: "domain_apify_run_id", notes: "domain_notes" },
  waterfall: { status: "waterfall_status", runId: "waterfall_apify_run_id", notes: "waterfall_notes" },
  activity: { status: "activity_status", runId: "activity_apify_run_id", notes: "activity_notes" },
};

function estimatePerItem(phase: EnrichmentPhase): number {
  switch (phase) {
    case "profiles": return PROFILE_EMAIL_COST_USD;
    case "domains": return DOMAIN_COST_USD;
    case "waterfall": return WATERFALL_LEAD_COST_USD;
    case "activity": return ACTIVITY_COST_USD;
    default: return 0;
  }
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
  const provider = getProvider(phase, run.waterfall_actor);
  if (!provider) {
    await advancePhase(admin, run);
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
): Promise<Record<string, unknown>> {
  if (!provider) return { status: "advanced" };

  const batchSize = BATCH_SIZE;
  const { data: pendingData } = await admin
    .from("enrichment_run_items")
    .select(ENRICH_ITEM_WORK_COLUMNS)
    .eq("run_id", run.id)
    .eq(cols.status, "pending")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(batchSize);

  let batch = (pendingData as ItemRow[] | null) ?? [];
  if (batch.length === 0) {
    await advancePhase(admin, run);
    return { status: "advanced", phase: run.phase };
  }

  // Re-check the contacts — someone may have filled the target field since the
  // run was created / a prior phase ran.
  batch = await dropAlreadyDone(admin, run, phase, cols, batch);
  if (batch.length === 0) {
    return { status: "skipped_batch" };
  }

  const input = provider.buildInput(batch);
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
  const arrays = [obj.urls, obj.companies, obj.people, obj.emails, obj.startUrls];
  const anyNonEmpty = arrays.some((a) => Array.isArray(a) && a.length > 0);
  return !anyNonEmpty;
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
          domain_notes: res.extra?.matched_by ? `matched by ${res.extra.matched_by}` : null,
          cost_usd: share,
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
  return run.waterfall_actor?.includes("bovi") ? "bovi" : "vdrmota";
}

async function writeEmail(
  admin: Admin,
  cols: { status: string; runId: string; notes: string },
  item: ItemRow,
  res: PhaseResult,
  contact: Contact | undefined,
  providerId: EmailProviderId,
  share: number,
): Promise<"found" | "not_found" | "skipped"> {
  const now = new Date().toISOString();
  const extraPatch = (res.extra ?? {}) as Record<string, unknown>;
  const companyEmailsPatch = extraPatch.company_emails ? { company_emails: extraPatch.company_emails } : {};

  if (res.status !== "found" || !res.email) {
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "not_found", [cols.notes]: "no email found", cost_usd: share })
      .eq("id", item.id);
    return "not_found";
  }

  const san = sanitizeFoundEmail(res.email, {
    firstName: item.first_name,
    lastName: item.last_name,
    domain: item.company_domain,
  });
  if (!san.email) {
    await admin
      .from("enrichment_run_items")
      .update({ [cols.status]: "not_found", [cols.notes]: `provider junk email: ${san.rejectReason}`, cost_usd: share })
      .eq("id", item.id);
    return "not_found";
  }

  const noteFlags = san.flags.length ? san.flags.join("; ") : null;
  // The provider's own status string (e.g. vdrmota/bovi verdict), kept as
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
    const tags = Array.from(new Set([...(contact.tags ?? []), "enriched", "apify"]));
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
    .select("id, email, company_domain")
    .eq("organization_id", run.organization_id)
    .in("id", contactIds);
  const map = new Map(
    ((data as { id: string; email: string | null; company_domain: string | null }[] | null) ?? []).map(
      (c) => [c.id, c],
    ),
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
}

// Move to the next enabled phase that has work; finalize when none remain.
async function advancePhase(admin: Admin, run: RunRow): Promise<void> {
  let phase: EnrichmentPhase = run.phase;

  for (;;) {
    if (phase === "profiles") {
      phase = "domains";
      if (run.run_domains) {
        // Re-activate domain items that the profile phase gave a company URL to.
        await admin
          .from("enrichment_run_items")
          .update({ domain_status: "pending", attempts: 0 })
          .eq("run_id", run.id)
          .eq("domain_status", "skipped")
          .is("company_domain", null)
          .not("company_id", "is", null);
        const n = await countPending(admin, run.id, "domain_status");
        if (n > 0) break;
      }
      continue;
    }
    if (phase === "domains") {
      phase = "waterfall";
      if (run.run_waterfall) {
        await admin
          .from("enrichment_run_items")
          .update({ waterfall_status: "pending", attempts: 0 })
          .eq("run_id", run.id)
          .is("email", null)
          .not("company_domain", "is", null);
        const n = await countPending(admin, run.id, "waterfall_status");
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
    // activity → done
    phase = "complete";
    break;
  }

  if (phase === "complete") {
    const counts = await recomputeCounters(admin, run);
    await admin
      .from("enrichment_runs")
      .update({
        status: "complete",
        phase: "complete",
        completed_at: new Date().toISOString(),
        locked_at: null,
        progress_message: `Emails ${counts.found_emails_count} · domains ${counts.found_domains_count} · activity ${counts.found_activity_count}`,
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
  };

  // Don't clobber a completed run's terminal message; just persist counts +
  // release the lease (if not already released by advance/fail).
  await admin
    .from("enrichment_runs")
    .update({ ...counters, locked_at: null })
    .eq("id", run.id);

  return counters;
}
