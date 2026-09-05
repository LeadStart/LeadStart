import { NextRequest, NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { ENRICH_RUN_COLUMNS, ENRICH_ITEM_COLUMNS } from "@/lib/apify/columns";

// GET /api/admin/contacts/enrich/run/[id]
// Returns the parent run + all its items. The contacts page polls this every
// 3s while a run is active. Items are paged with .range() because PostgREST
// caps a select at 1,000 rows and a run can hold up to 2,000.

export const maxDuration = 10;

const PAGE = 1000;
const MAX_ITEMS = 5000;

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const { data: runRow, error: runError } = await admin
    .from("enrichment_runs")
    .select(ENRICH_RUN_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (runError) {
    return NextResponse.json({ error: runError.message }, { status: 500 });
  }
  if (!runRow) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  if ((runRow as unknown as { organization_id: string }).organization_id !== organizationId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const items: unknown[] = [];
  for (let offset = 0; offset < MAX_ITEMS; offset += PAGE) {
    const { data, error } = await admin
      .from("enrichment_run_items")
      .select(ENRICH_ITEM_COLUMNS)
      .eq("run_id", id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    const page = data ?? [];
    items.push(...page);
    if (page.length < PAGE) break;
  }

  // Join contacts.company_email (migration 00076) onto each item so the search
  // results can chart person-email vs company-only vs none: the generic inbox
  // lives on the contact, not the run item.
  const contactIds = Array.from(
    new Set(items.map((it) => (it as { contact_id?: string }).contact_id).filter(Boolean) as string[]),
  );
  if (contactIds.length) {
    type ContactJoin = {
      company_email: string | null;
      email_kind: string | null;
      email_provider_status: string | null;
    };
    const byId = new Map<string, ContactJoin>();
    for (let i = 0; i < contactIds.length; i += PAGE) {
      const { data } = await admin
        .from("contacts")
        .select(
          // email_kind/email_provider_status are scalar projections out of
          // enrichment_data (generic-inbox kind + catch-all provenance) so the
          // results table can tier/badge each row without the JSONB blob.
          "id, company_email, email_kind:enrichment_data->enrichment->email->>kind, email_provider_status:enrichment_data->enrichment->email->>provider_status",
        )
        .in("id", contactIds.slice(i, i + PAGE));
      for (const c of (data ?? []) as unknown as ({ id: string } & ContactJoin)[]) {
        byId.set(c.id, {
          company_email: c.company_email,
          email_kind: c.email_kind,
          email_provider_status: c.email_provider_status,
        });
      }
    }
    for (const it of items) {
      const join = byId.get((it as { contact_id?: string }).contact_id ?? "");
      (it as { company_email?: string | null }).company_email = join?.company_email ?? null;
      (it as { email_kind?: string | null }).email_kind = join?.email_kind ?? null;
      (it as { email_provider_status?: string | null }).email_provider_status =
        join?.email_provider_status ?? null;
    }
  }

  return NextResponse.json({ run: runRow, items });
}
