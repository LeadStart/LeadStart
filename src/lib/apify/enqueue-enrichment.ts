import type { SupabaseClient } from "@supabase/supabase-js";
import { extractProfileId, extractCompanyId, extractCompanySlug } from "./domain";
import { PROFILE_ACTOR, DOMAIN_ACTOR, ACTIVITY_ACTOR, resolveWaterfallActor } from "./providers";
import { loadEnrichmentSettings, normalizeAddons } from "./auth";

// Auto-enrichment enqueue — the "queue-behind" heart of the Prospecting →
// Contacts handoff. Given a set of contact ids, it either starts an enrichment
// run immediately (org is free) or stamps them enrich_queued_at (a run is
// already active — one-active-run-per-org) so the drain cron picks them up when
// the org frees. Mirrors the run/item shape built by contacts/enrich/start.

type ContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  company_linkedin_url: string | null;
  company_domain: string | null;
  enrichment_data: Record<string, unknown> | null;
};

export type EnqueueResult =
  | { status: "started"; runId: string; total: number }
  | { status: "queued"; count: number }
  | { status: "skipped"; reason: string };

const CHUNK = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Contacts with real enrichment work: no email + a parseable profile URL, or a
// missing domain + a parseable company URL. (Activity also only needs a profile
// URL; the worker assigns it its own phase.)
function buildItemRows(contacts: ContactRow[], organizationId: string, now: string) {
  const rows: Record<string, unknown>[] = [];
  const eligibleContactIds: string[] = [];
  for (const c of contacts) {
    const profileId = extractProfileId(c.linkedin_url);
    const companyId = extractCompanyId(c.company_linkedin_url);
    const companySlug = extractCompanySlug(c.company_linkedin_url);
    const wantProfile = !c.email && Boolean(profileId);
    const wantDomain = !c.company_domain && Boolean(companyId || companySlug);
    const wantActivity = Boolean(profileId);
    if (!wantProfile && !wantDomain && !wantActivity) continue;
    eligibleContactIds.push(c.id);
    rows.push({
      organization_id: organizationId,
      contact_id: c.id,
      linkedin_url: c.linkedin_url,
      profile_id: profileId,
      company_linkedin_url: c.company_linkedin_url,
      company_id: companyId,
      company_slug: companySlug,
      company_name: c.company_name,
      first_name: c.first_name,
      last_name: c.last_name,
      company_domain: c.company_domain,
      profile_status: wantProfile ? "pending" : "skipped",
      profile_notes: wantProfile ? null : c.email ? "already has email" : "no parseable LinkedIn profile URL",
      domain_status: wantDomain ? "pending" : "skipped",
      domain_notes: wantDomain ? null : c.company_domain ? "already has company domain" : "no parseable company LinkedIn URL",
      waterfall_status: null,
      email: c.email,
      created_at: now,
      updated_at: now,
    });
  }
  return { rows, eligibleContactIds };
}

export async function enqueueEnrichment(
  admin: SupabaseClient,
  opts: { organizationId: string; userId: string; contactIds: string[] },
): Promise<EnqueueResult> {
  const { organizationId, userId } = opts;
  const contactIds = Array.from(new Set(opts.contactIds.filter(Boolean)));
  if (contactIds.length === 0) return { status: "skipped", reason: "no_contacts" };

  // Load the contacts.
  const contacts: ContactRow[] = [];
  for (const part of chunk(contactIds, CHUNK)) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, first_name, last_name, email, company_name, linkedin_url, company_linkedin_url, company_domain, enrichment_data")
      .eq("organization_id", organizationId)
      .in("id", part);
    if (error) return { status: "skipped", reason: error.message };
    contacts.push(...((data as ContactRow[] | null) ?? []));
  }

  const now = new Date().toISOString();
  const { rows, eligibleContactIds } = buildItemRows(contacts, organizationId, now);
  if (rows.length === 0) {
    // Nothing to enrich — clear any stale queue stamp so the drain lets go.
    await admin.from("contacts").update({ enrich_queued_at: null }).in("id", contactIds);
    return { status: "skipped", reason: "nothing_eligible" };
  }

  // Add-on gating (migration 00077). Activity + verify default OFF; a contact
  // opts in via the `addons` stamped on its enrichment_data at import time
  // (import-prospects). `.some` is generous to a drain-merged mixed batch: if any
  // person wanted an add-on, the run does that phase. Activity additionally
  // respects the "already active on LinkedIn" skip so we don't re-measure what
  // the search already filtered on.
  const eligibleSet = new Set(eligibleContactIds);
  const eligible = contacts.filter((c) => eligibleSet.has(c.id));
  const addonsFor = (c: ContactRow) =>
    normalizeAddons((c.enrichment_data as { addons?: unknown } | null)?.addons);
  const allSkipActivity = eligible.every(
    (c) => (c.enrichment_data as { skip_activity?: boolean } | null)?.skip_activity === true,
  );
  const runActivity = eligible.some((c) => addonsFor(c).activity) && !allSkipActivity;
  const runVerify = eligible.some((c) => addonsFor(c).verify);

  // One active run per org → if busy, stamp the eligible contacts and bail.
  const { data: activeRows } = await admin
    .from("enrichment_runs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (activeRows && activeRows.length > 0) {
    for (const part of chunk(eligibleContactIds, CHUNK)) {
      await admin.from("contacts").update({ enrich_queued_at: now }).in("id", part);
    }
    return { status: "queued", count: eligibleContactIds.length };
  }

  // Snapshot the org's waterfall config (migration 00075) onto the run, same as
  // contacts/enrich/start — so an auto-enqueued run honors the configured method
  // + size routing (not a hardcoded vdrmota default).
  const settings = await loadEnrichmentSettings(admin, organizationId);
  const waterfallActor = resolveWaterfallActor(settings);
  const runWaterfall =
    settings.waterfall_enabled &&
    (settings.small_method !== "off" || settings.large_method !== "off" || settings.unknown_method !== "off");

  // Free → create the run (all four phases) + its items.
  const { data: runRow, error: runError } = await admin
    .from("enrichment_runs")
    .insert({
      organization_id: organizationId,
      created_by: userId,
      profile_actor: PROFILE_ACTOR,
      domain_actor: DOMAIN_ACTOR,
      waterfall_actor: runWaterfall ? waterfallActor : null,
      activity_actor: runActivity ? ACTIVITY_ACTOR : null,
      waterfall_config: settings,
      run_profiles: true,
      run_domains: true,
      run_waterfall: runWaterfall,
      run_activity: runActivity,
      run_verify: runVerify,
      phase: "profiles",
      status: "pending",
      total_count: rows.length,
    })
    .select("id")
    .single();

  if (runError || !runRow) {
    // Lost the race for the single active slot → queue instead.
    if ((runError as { code?: string } | null)?.code === "23505") {
      for (const part of chunk(eligibleContactIds, CHUNK)) {
        await admin.from("contacts").update({ enrich_queued_at: now }).in("id", part);
      }
      return { status: "queued", count: eligibleContactIds.length };
    }
    return { status: "skipped", reason: runError?.message ?? "run_insert_failed" };
  }

  const runId = (runRow as { id: string }).id;
  for (const part of chunk(rows, CHUNK)) {
    const { error: itemsError } = await admin
      .from("enrichment_run_items")
      .insert(part.map((r) => ({ ...r, run_id: runId })));
    if (itemsError) {
      await admin.from("enrichment_runs").delete().eq("id", runId);
      return { status: "skipped", reason: itemsError.message };
    }
  }

  // Enrolled → clear the queue stamp so the drain doesn't re-pick them.
  for (const part of chunk(eligibleContactIds, CHUNK)) {
    await admin.from("contacts").update({ enrich_queued_at: null }).in("id", part);
  }

  return { status: "started", runId, total: rows.length };
}
