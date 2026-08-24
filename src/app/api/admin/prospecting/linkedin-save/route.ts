import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import type { LinkedInProspect } from "@/types/app";
import { enqueueEnrichment, type EnqueueResult } from "@/lib/apify/enqueue-enrichment";

// POST /api/admin/prospecting/linkedin-save
//
// Body: { search_id, linkedin_urls: string[], campaign_id?: string }
//
// The Prospecting → Contacts handoff. Saves the chosen sourced people into
// contacts (deduped by lower(linkedin_url), the pre-flight pattern the Scrap.io
// save uses for email) and, when campaign_id is given, assigns them to that
// campaign. Enrichment (the waterfall) and sequence enrollment happen downstream
// in Contacts — this route only imports + assigns.

export const maxDuration = 30;

const CHUNK = 200;

type Body = { search_id?: unknown; linkedin_urls?: unknown; campaign_id?: unknown };

function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function POST(request: NextRequest) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { user, organizationId, admin } = ctx;

  const body = (await request.json().catch(() => ({}))) as Body;
  const searchId = typeof body.search_id === "string" ? body.search_id : "";
  const wantUrls = Array.isArray(body.linkedin_urls)
    ? new Set(
        body.linkedin_urls.filter((v): v is string => typeof v === "string").map(lc),
      )
    : new Set<string>();
  const campaignId =
    typeof body.campaign_id === "string" && body.campaign_id ? body.campaign_id : null;

  if (!searchId) return NextResponse.json({ error: "search_id is required" }, { status: 400 });
  if (wantUrls.size === 0) {
    return NextResponse.json({ error: "Select at least one person" }, { status: 400 });
  }

  const { data: searchRow, error: searchErr } = await admin
    .from("linkedin_searches")
    .select("id, organization_id, results, saved_count, query")
    .eq("id", searchId)
    .maybeSingle();
  if (searchErr) return NextResponse.json({ error: searchErr.message }, { status: 500 });
  if (!searchRow) return NextResponse.json({ error: "Search not found" }, { status: 404 });
  if ((searchRow as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // If the search already filtered on "active on LinkedIn", the imported people
  // are known-active — stamp them so auto-enrich skips the redundant activity pass.
  const searchLevers =
    (searchRow as { query?: { levers?: { recentlyPostedOnLinkedIn?: boolean } } }).query?.levers ?? {};
  const skipActivity = searchLevers.recentlyPostedOnLinkedIn === true;

  // If a campaign is targeted, confirm it belongs to the org.
  if (campaignId) {
    const { data: camp } = await admin
      .from("campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!camp) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const cached = ((searchRow as { results: LinkedInProspect[] | null }).results ?? []).filter(
    (p) => p.linkedin_url && wantUrls.has(lc(p.linkedin_url)),
  );

  // Dedupe within the batch by lower(linkedin_url).
  const byUrl = new Map<string, LinkedInProspect>();
  for (const p of cached) {
    const k = lc(p.linkedin_url);
    if (k && !byUrl.has(k)) byUrl.set(k, p);
  }
  const chosen = Array.from(byUrl.values());

  // Cross-batch dedupe against contacts already in the org (idx_contacts_org_linkedin).
  const existing = new Set<string>();
  const urlVariants = Array.from(
    new Set(chosen.flatMap((p) => [p.linkedin_url as string, (p.linkedin_url as string).toLowerCase()])),
  );
  for (const part of chunk(urlVariants, 300)) {
    const { data } = await admin
      .from("contacts")
      .select("linkedin_url")
      .eq("organization_id", organizationId)
      .in("linkedin_url", part);
    for (const r of (data as { linkedin_url: string | null }[] | null) ?? []) {
      if (r.linkedin_url) existing.add(lc(r.linkedin_url));
    }
  }

  // Also dedupe by email (idx_contacts_org_email_unique, on lower(email)). The
  // linkedin_url check alone let a single pre-existing email violate the unique
  // constraint and fail the WHOLE batch insert — saving nothing.
  const existingEmails = new Set<string>();
  const emailVariants = Array.from(
    new Set(
      chosen
        .map((p) => p.email)
        .filter((e): e is string => Boolean(e && e.trim()))
        .flatMap((e) => [e, e.toLowerCase()]),
    ),
  );
  for (const part of chunk(emailVariants, 300)) {
    const { data } = await admin
      .from("contacts")
      .select("email")
      .eq("organization_id", organizationId)
      .in("email", part);
    for (const r of (data as { email: string | null }[] | null) ?? []) {
      if (r.email) existingEmails.add(lc(r.email));
    }
  }

  const now = new Date().toISOString();
  const seenEmail = new Set<string>();
  const toInsert = chosen
    .filter((p) => {
      if (existing.has(lc(p.linkedin_url))) return false;
      const e = lc(p.email);
      if (e) {
        // Skip an email that's already in the org, or repeated within this batch.
        if (existingEmails.has(e) || seenEmail.has(e)) return false;
        seenEmail.add(e);
      }
      return true;
    })
    .map((p) => ({
      organization_id: organizationId,
      client_id: null,
      campaign_id: campaignId,
      first_name: p.first_name,
      last_name: p.last_name,
      email: p.email,
      company_name: p.company_name,
      title: p.headline,
      linkedin_url: p.linkedin_url,
      company_linkedin_url: p.company_linkedin_url,
      company_domain: p.company_domain,
      enrichment_data: { linkedin_search_id: searchId, skip_activity: skipActivity, source_row: p },
      tags: ["linkedin", "prospecting"],
      status: "new",
      source: "linkedin-prospecting",
      pipeline_stage: "lead",
      pipeline_sort_order: 0,
      pipeline_added_at: now,
      created_at: now,
      updated_at: now,
    }));

  let inserted = 0;
  const insertedIds: string[] = [];
  for (const part of chunk(toInsert, CHUNK)) {
    const { data, error } = await admin.from("contacts").insert(part).select("id");
    if (!error) {
      const ids = (data as { id: string }[] | null) ?? [];
      inserted += ids.length;
      for (const r of ids) insertedIds.push(r.id);
      continue;
    }
    // A residual unique-constraint collision (23505) must not sink the whole
    // batch — retry this chunk row-by-row and skip only the rows that conflict.
    if (error.code === "23505") {
      for (const oneRow of part) {
        const { data: one, error: oneErr } = await admin
          .from("contacts")
          .insert(oneRow)
          .select("id");
        if (oneErr) {
          if (oneErr.code === "23505") continue; // already exists — skip
          console.error("[linkedin-save] row insert failed:", oneErr);
          return NextResponse.json({ error: oneErr.message }, { status: 500 });
        }
        const ids = (one as { id: string }[] | null) ?? [];
        inserted += ids.length;
        for (const r of ids) insertedIds.push(r.id);
      }
      continue;
    }
    console.error("[linkedin-save] insert failed:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const prevSaved = (searchRow as { saved_count: number | null }).saved_count ?? 0;
  await admin
    .from("linkedin_searches")
    .update({ saved_count: prevSaved + inserted })
    .eq("id", searchId);

  // Auto-enrich the freshly imported people. Queue-behind: if a run is already
  // active for the org, they're stamped enrich_queued_at and the drain cron
  // starts them once the org frees.
  let enrichment: EnqueueResult = { status: "skipped", reason: "no_contacts" };
  if (insertedIds.length) {
    enrichment = await enqueueEnrichment(admin, {
      organizationId,
      userId: user.id,
      contactIds: insertedIds,
    });
  }

  return NextResponse.json({
    requested: wantUrls.size,
    inserted,
    skipped_duplicates: chosen.length - inserted,
    campaign_id: campaignId,
    enrichment,
  });
}
