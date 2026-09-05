// GET /api/buyer/contacts/export: download the buyer's own sourced contacts as
// CSV (their org, newest first). Service-role, scoped to the buyer's org. Capped
// at MAX_ROWS so a runaway export can't blow the response; a buyer at the cap can
// narrow with the on-page search before exporting.

import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const MAX_ROWS = 10_000;
const PAGE = 1000;

const EXPORT_COLS =
  "first_name, last_name, email, title, company_name, company_domain, company_email, company_phone, phone, linkedin_url, location, email_verification_status, source, created_at";

const HEADERS = [
  "First Name", "Last Name", "Email", "Title", "Company", "Company Domain",
  "Company Email", "Company Phone", "Phone", "LinkedIn", "Location",
  "Email Status", "Source", "Sourced At",
];

type Row = Record<string, string | null>;
const FIELDS = EXPORT_COLS.split(",").map((c) => c.trim());

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "buyer") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const organizationId = user.app_metadata?.organization_id as string | undefined;
  if (!organizationId) return NextResponse.json({ error: "No organization" }, { status: 400 });

  const admin = createAdminClient();
  const rows: Row[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await admin
      .from("contacts")
      .select(EXPORT_COLS)
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const batch = (data as Row[] | null) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  const lines = [HEADERS.map(csvCell).join(",")];
  for (const r of rows) lines.push(FIELDS.map((f) => csvCell(r[f])).join(","));
  const csv = lines.join("\r\n");

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leadstart-contacts-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
