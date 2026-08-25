import { NextRequest, NextResponse } from "next/server";
import { loadEnrichmentSettings, requireEnrichmentContext } from "@/lib/apify/auth";
import { extractProfileId, extractCompanyId, extractCompanySlug } from "@/lib/apify/domain";
import {
  PROFILE_ACTOR,
  DOMAIN_ACTOR,
  ACTIVITY_ACTOR,
  resolveWaterfallActor,
} from "@/lib/apify/providers";

// POST /api/admin/contacts/enrich/start
//
// Body: { contact_ids: string[], run_profiles?, run_domains?, run_waterfall?,
//         run_activity? } (all steps default true). Email verification is NOT a
// step here — Million Verifier owns it at its own pre-send gate.
//
// Creates one enrichment_runs row + one enrichment_run_items row per eligible
// contact. The cron worker (run-apify-enrichment) picks it up. One active run
// per org (partial unique index → 23505 → 409).

export const maxDuration = 30;

const MAX_IDS = 2000;
const CHUNK = 500;

type Body = {
  contact_ids?: unknown;
  run_profiles?: unknown;
  run_domains?: unknown;
  run_waterfall?: unknown;
  run_activity?: unknown;
  run_verify?: unknown;
};

type ContactRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  linkedin_url: string | null;
  company_linkedin_url: string | null;
  company_domain: string | null;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin, apifyToken } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;
  const contactIds = Array.isArray(body.contact_ids)
    ? Array.from(
        new Set(
          body.contact_ids.filter((v): v is string => typeof v === "string" && v.length > 0),
        ),
      )
    : [];
  const runProfiles = body.run_profiles === undefined ? true : Boolean(body.run_profiles);
  const runDomains = body.run_domains === undefined ? true : Boolean(body.run_domains);
  const runWaterfall = body.run_waterfall === undefined ? true : Boolean(body.run_waterfall);
  // Activity + verify are opt-in add-ons here (default OFF), matching the
  // Prospecting per-search toggles.
  const runActivity = body.run_activity === undefined ? false : Boolean(body.run_activity);
  const runVerify = body.run_verify === undefined ? false : Boolean(body.run_verify);

  if (contactIds.length === 0) {
    return NextResponse.json({ error: "contact_ids is required" }, { status: 400 });
  }
  if (contactIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_IDS} contacts per run` },
      { status: 400 },
    );
  }
  if (!runProfiles && !runDomains && !runWaterfall && !runActivity && !runVerify) {
    return NextResponse.json({ error: "Select at least one enrichment step" }, { status: 400 });
  }
  // The core phases run on Apify; verify is Million Verifier only. Require the
  // Apify token only when an Apify phase is requested (a verify-only run doesn't
  // need it).
  const needsApify = runProfiles || runDomains || runWaterfall || runActivity;
  if (needsApify && !apifyToken) {
    return NextResponse.json(
      { error: "Apify API token not set. Save it in /admin/settings/api first." },
      { status: 400 },
    );
  }

  // Org waterfall config (migration 00075). The run_waterfall request is honored
  // when the org's waterfall is enabled AND at least one size band names a real
  // method (not 'off'). The Apify actor snapshot may be null when every band is
  // a direct method (pattern_mv) — that's fine, the worker routes per item. The
  // settings are snapshotted onto the run so it never re-reads live config.
  const settings = await loadEnrichmentSettings(admin, organizationId);
  const waterfallActor = resolveWaterfallActor(settings);
  const waterfallHasWork =
    settings.small_method !== "off" ||
    settings.large_method !== "off" ||
    settings.unknown_method !== "off";
  const runWaterfallEffective =
    runWaterfall && settings.waterfall_enabled && waterfallHasWork;
  if (!runProfiles && !runDomains && !runWaterfallEffective && !runActivity && !runVerify) {
    // Only the waterfall was requested and config disables it.
    return NextResponse.json(
      {
        error:
          "The second-pass waterfall is turned off in Settings → Integrations (Enrichment waterfall card)",
      },
      { status: 400 },
    );
  }

  // First enabled phase. When verify is the ONLY phase, its items are seeded at
  // creation (there's no earlier phase for advancePhase to seed them from).
  const initialPhase = runProfiles
    ? "profiles"
    : runDomains
      ? "domains"
      : runWaterfallEffective
        ? "waterfall"
        : runActivity
          ? "activity"
          : "verify";
  const seedVerifyNow = initialPhase === "verify";

  // One active run per org.
  const { data: activeRows } = await admin
    .from("enrichment_runs")
    .select("id")
    .eq("organization_id", organizationId)
    .in("status", ["pending", "running"])
    .limit(1);
  if (activeRows && activeRows.length > 0) {
    return NextResponse.json(
      { error: "An enrichment run is already in progress for this organization", active_run_id: (activeRows[0] as { id: string }).id },
      { status: 409 },
    );
  }

  // Load the contacts (chunked to respect the id-list size).
  const contacts: ContactRow[] = [];
  for (const part of chunk(contactIds, CHUNK)) {
    const { data, error } = await admin
      .from("contacts")
      .select("id, first_name, last_name, email, company_name, linkedin_url, company_linkedin_url, company_domain")
      .eq("organization_id", organizationId)
      .in("id", part);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    contacts.push(...((data as ContactRow[] | null) ?? []));
  }

  const skipped = {
    not_found_in_org: contactIds.length - contacts.length,
    no_linkedin_url: 0,
    already_has_email: 0,
    no_company_linkedin_url: 0,
    already_has_domain: 0,
  };

  const now = new Date().toISOString();
  const itemRows: Record<string, unknown>[] = [];

  for (const c of contacts) {
    const profileId = extractProfileId(c.linkedin_url);
    const companyId = extractCompanyId(c.company_linkedin_url);
    const companySlug = extractCompanySlug(c.company_linkedin_url);
    const hasCompanyRef = Boolean(companyId || companySlug);

    const wantProfile = runProfiles && !c.email && Boolean(profileId);
    const wantDomain = runDomains && !c.company_domain && hasCompanyRef;
    // Activity scoring only needs a profile URL — works even for contacts that
    // already have an email/domain (assigned to its phase by the worker).
    const wantActivity = runActivity && Boolean(profileId);
    // Verify only applies to a contact that already has (or will have) an email.
    // Profiles/waterfall may add one later, so a contact with a profile URL is
    // also verifiable downstream even without an email today.
    const wantVerify = runVerify && (Boolean(c.email) || wantProfile || wantDomain);

    if (!wantProfile && !wantDomain && !wantActivity && !wantVerify) {
      // Attribute one skip reason (priority order).
      if (c.email) skipped.already_has_email++;
      else if (runProfiles && !profileId) skipped.no_linkedin_url++;
      else if (c.company_domain) skipped.already_has_domain++;
      else skipped.no_company_linkedin_url++;
      continue;
    }

    const profileNote = wantProfile
      ? null
      : !runProfiles
        ? "profiles step disabled"
        : c.email
          ? "already has email"
          : "no parseable LinkedIn profile URL";
    const domainNote = wantDomain
      ? null
      : !runDomains
        ? "domains step disabled"
        : c.company_domain
          ? "already has company domain"
          : "no parseable company LinkedIn URL";

    itemRows.push({
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
      profile_notes: profileNote,
      domain_status: wantDomain ? "pending" : "skipped",
      domain_notes: domainNote,
      // waterfall/activity are assigned by the worker's advancePhase. verify is
      // too, UNLESS it's the only phase (nothing earlier to trigger the seed) —
      // then seed it here for contacts that already have an email.
      waterfall_status: null,
      verify_status: seedVerifyNow && c.email ? "pending" : null,
      email: c.email,
      created_at: now,
      updated_at: now,
    });
  }

  if (itemRows.length === 0) {
    return NextResponse.json(
      { error: "Nothing to enrich for the selected contacts", skipped },
      { status: 400 },
    );
  }

  const { data: runRow, error: runError } = await admin
    .from("enrichment_runs")
    .insert({
      organization_id: organizationId,
      created_by: user.id,
      profile_actor: PROFILE_ACTOR,
      domain_actor: DOMAIN_ACTOR,
      waterfall_actor: runWaterfallEffective ? waterfallActor : null,
      activity_actor: runActivity ? ACTIVITY_ACTOR : null,
      waterfall_config: settings,
      run_profiles: runProfiles,
      run_domains: runDomains,
      run_waterfall: runWaterfallEffective,
      run_activity: runActivity,
      run_verify: runVerify,
      phase: initialPhase,
      status: "pending",
      total_count: itemRows.length,
    })
    .select("id")
    .single();

  if (runError || !runRow) {
    // Unique partial index → another run beat us to it.
    if ((runError as { code?: string } | null)?.code === "23505") {
      return NextResponse.json(
        { error: "An enrichment run is already in progress for this organization" },
        { status: 409 },
      );
    }
    console.error("[enrich/start] run insert failed:", runError);
    return NextResponse.json(
      { error: runError?.message ?? "Failed to create enrichment run" },
      { status: 500 },
    );
  }
  const runId = (runRow as { id: string }).id;

  for (const part of chunk(itemRows, CHUNK)) {
    const { error: itemsError } = await admin
      .from("enrichment_run_items")
      .insert(part.map((r) => ({ ...r, run_id: runId })));
    if (itemsError) {
      // Clean up the orphan run so the cron doesn't pick up empty work.
      await admin.from("enrichment_runs").delete().eq("id", runId);
      console.error("[enrich/start] items insert failed:", itemsError);
      return NextResponse.json({ error: itemsError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ run_id: runId, total: itemRows.length, skipped });
}
