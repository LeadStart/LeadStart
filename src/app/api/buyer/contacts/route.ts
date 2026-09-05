// GET /api/buyer/contacts: the buyer's own sourced contacts (their org), newest
// first, paginated 25/page. Served via the service-role client scoped to the
// buyer's org (contacts RLS is owner/va-only, so buyers never read it directly).
// This is the "results" surface: what a buyer paid for and can work + download.

import { NextRequest, NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const PAGE_SIZE = 25;

const LIST_COLS =
  "id, first_name, last_name, email, title, company_name, company_domain, company_email, company_phone, phone, linkedin_url, location, email_verification_status, source, created_at";

export async function GET(req: NextRequest) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization" }, { status: 400 });

  const url = new URL(req.url);
  const page = Math.max(1, Math.floor(Number(url.searchParams.get("page")) || 1));
  const q = (url.searchParams.get("q") || "").trim();
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const admin = createAdminClient();
  let query = admin
    .from("contacts")
    .select(LIST_COLS, { count: "exact" })
    .eq("organization_id", organizationId);
  if (q) {
    // Match on the fields a buyer would search by. `or` filter across text columns.
    const like = `%${q.replace(/[%,()]/g, "")}%`;
    query = query.or(
      `first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},company_name.ilike.${like}`,
    );
  }
  const { data, count, error } = await query.order("created_at", { ascending: false }).range(from, to);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    contacts: data ?? [],
    total: count ?? 0,
    page,
    page_size: PAGE_SIZE,
  });
}
