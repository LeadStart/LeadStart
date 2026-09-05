import { NextRequest, NextResponse } from "next/server";
import { loadEnrichmentSettings, requireEnrichmentContext } from "@/lib/apify/auth";
import { extractProfileId, extractCompanyId, extractCompanySlug } from "@/lib/apify/domain";
import {
  PROFILE_ACTOR,
  DOMAIN_ACTOR,
  ACTIVITY_ACTOR,
  resolveWaterfallActor,
} from "@/lib/apify/providers";
import { hasUsableName, methodForItem } from "@/lib/enrichment/waterfall-routing";

// POST /api/admin/contacts/enrich/start
//
// Body: { contact_ids: string[], run_profiles?, run_domains?, run_waterfall?,
//         run_activity? } (all steps default true). Email verification is NOT a
// step here: Million Verifier owns it at its own pre-send gate.
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
  run_naming?: unknown;
  include_catch_all?: unknown;
  validate_catch_all?: unknown;
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
  // Owner-name discovery add-on (default OFF). No Apify: decision-maker Layer 1/2.
  const runNaming = body.run_naming === undefined ? false : Boolean(body.run_naming);
  // Per-run catch-all opt-in (default OFF): ORs over the org setting by flipping
  // accept_catch_all_guesses on this run's config snapshot: pattern_mv then
  // keeps the best catch-all guess (confidence 40, flagged) instead of dropping it.
  const includeCatchAll =
    body.include_catch_all === undefined ? false : Boolean(body.include_catch_all);
  // Findymail catch-all validation add-on (default OFF): ORs over the org setting
  // by flipping validate_catch_all on this run's config snapshot: the cron then
  // hands catch-all misses to Findymail to recover a deliverable address.
  const validateCatchAll =
    body.validate_catch_all === undefined ? false : Boolean(body.validate_catch_all);

  if (contactIds.length === 0) {
    return NextResponse.json({ error: "contact_ids is required" }, { status: 400 });
  }
  if (contactIds.length > MAX_IDS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_IDS} contacts per run` },
      { status: 400 },
    );
  }
  if (!runProfiles && !runDomains && !runWaterfall && !runActivity && !runVerify && !runNaming) {
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
  // a direct method (pattern_mv): that's fine, the worker routes per item. The
  // settings are snapshotted onto the run so it never re-reads live config.
  const settings = await loadEnrichmentSettings(admin, organizationId);
  const waterfallActor = resolveWaterfallActor(settings);
  const waterfallHasWork =
    settings.small_method !== "off" ||
    settings.large_method !== "off" ||
    settings.unknown_method !== "off";
  const runWaterfallEffective =
    runWaterfall && settings.waterfall_enabled && waterfallHasWork;
  if (!runProfiles && !runDomains && !runWaterfallEffective && !runActivity && !runVerify && !runNaming) {
    // Only the waterfall was requested and config disables it.
    return NextResponse.json(
      {
        error:
          "The second-pass waterfall is turned off in Settings → Integrations (Enrichment waterfall card)",
      },
      { status: 400 },
    );
  }

  // First enabled phase. When a phase is the ONLY/first phase, its items are
  // seeded at creation (there's no earlier phase for advancePhase to seed from).
  // naming sits between domains and waterfall.
  const initialPhase = runProfiles
    ? "profiles"
    : runDomains
      ? "domains"
      : runNaming
        ? "naming"
        : runWaterfallEffective
          ? "waterfall"
          : runActivity
            ? "activity"
            : "verify";
  const seedVerifyNow = initialPhase === "verify";
  const seedNamingNow = initialPhase === "naming";
  // When waterfall is the ONLY phase (no profiles/domains ahead of it), there's
  // no domains→waterfall transition for the worker to seed from, so stamp the
  // method + pending at insert here (mirrors seedVerifyNow). Normal runs seed in
  // advancePhase.seedWaterfallItems.
  const seedWaterfallNow = initialPhase === "waterfall";

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
    // Name-only companies (no LinkedIn page) → web-lookup discovery in the
    // domains phase, when enabled. Lets a sourced-email + name-only contact
    // (which would otherwise be dropped) enter with a domain-discovery item.
    const wantDomainDiscovery =
      runDomains &&
      settings.domain_discovery_enabled &&
      !c.company_domain &&
      !hasCompanyRef &&
      Boolean(c.company_name?.trim());
    // A contact that already has a domain but no email (a Google-Maps business
    // lead, or any imported company+website row) still has waterfall work: the
    // site scraper can find a company/owner email. Without this it matched no
    // want-flag and was dropped from the run entirely.
    const wantWaterfallOnly = runWaterfallEffective && !c.email && Boolean(c.company_domain);
    // Owner-name discovery: a name-less, company-named contact (no email yet).
    // Works even without a domain (Layer 2 web-searches by name + city).
    const wantNaming =
      runNaming && !c.email && !c.first_name && !c.last_name && Boolean(c.company_name?.trim());
    // Activity scoring only needs a profile URL: works even for contacts that
    // already have an email/domain (assigned to its phase by the worker).
    const wantActivity = runActivity && Boolean(profileId);
    // Verify only applies to a contact that already has (or will have) an email.
    // Profiles/waterfall/naming may add one later, so a contact with a profile
    // URL, a discoverable domain, a waterfall-only domain, or a naming target is
    // verifiable downstream.
    const wantVerify =
      runVerify &&
      (Boolean(c.email) || wantProfile || wantDomain || wantDomainDiscovery || wantWaterfallOnly || wantNaming);

    if (
      !wantProfile &&
      !wantDomain &&
      !wantDomainDiscovery &&
      !wantWaterfallOnly &&
      !wantNaming &&
      !wantActivity &&
      !wantVerify
    ) {
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
    const domainNote =
      wantDomain || wantDomainDiscovery
        ? null
        : !runDomains
          ? "domains step disabled"
          : c.company_domain
            ? "already has company domain"
            : c.company_name
              ? "company not on LinkedIn (website discovery off)"
              : "no parseable company LinkedIn URL";

    // Waterfall seed for the "waterfall is the only phase" edge (seedWaterfallNow):
    // stamp method + pending now, since there's no domains→waterfall transition
    // ahead. employee_count is unknown at insert (null) → unknown-size band.
    const wfMethod =
      seedWaterfallNow && wantWaterfallOnly
        ? methodForItem(settings, null, hasUsableName(c.first_name, c.last_name))
        : null;
    const wfSeed =
      wfMethod == null
        ? { waterfall_status: null }
        : wfMethod === "off"
          ? { waterfall_status: "skipped", waterfall_method: "off", waterfall_notes: "waterfall off for this size band" }
          : {
              waterfall_status: "pending",
              waterfall_method: wfMethod,
              ...(hasUsableName(c.first_name, c.last_name)
                ? {}
                : { waterfall_notes: "no person name, routed to site scrape" }),
            };

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
      domain_status: wantDomain || wantDomainDiscovery ? "pending" : "skipped",
      domain_notes: domainNote,
      // naming/waterfall/activity are assigned by the worker's advancePhase.
      // verify + naming + waterfall are seeded here when one of them is the only
      // phase (nothing earlier to trigger the seed).
      naming_status: seedNamingNow && wantNaming ? "pending" : null,
      ...wfSeed,
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
      waterfall_config: {
        ...settings,
        accept_catch_all_guesses: includeCatchAll ? true : settings.accept_catch_all_guesses,
        validate_catch_all: validateCatchAll ? true : settings.validate_catch_all,
      },
      run_profiles: runProfiles,
      run_domains: runDomains,
      run_waterfall: runWaterfallEffective,
      run_activity: runActivity,
      run_verify: runVerify,
      run_naming: runNaming,
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
