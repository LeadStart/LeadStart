import { NextRequest, NextResponse } from "next/server";
import { requireManualTaskContext } from "@/lib/manual-tasks/auth";

// GET /api/admin/manual-tasks?status=open|done|skipped|all
//
// Lists the org's manual VA tasks for the "LinkedIn to-dos" inbox, joined with
// the contact (name / company / title / LinkedIn URL) and campaign each belongs
// to. Defaults to `open`; capped at 500 (a VA queue realistically stays well
// under that) with the page paginating 25/row client-side.

export const maxDuration = 10;

const LIST_CAP = 500;
const VALID_FILTERS = new Set(["open", "done", "skipped", "all"]);

const SELECT =
  "id, organization_id, campaign_id, contact_id, client_id, kind, flow_node_id, " +
  "rendered_body, status, assignee, created_by, completed_at, created_at, updated_at, " +
  "contact:contacts(id, first_name, last_name, company_name, title, linkedin_url, email), " +
  "campaign:campaigns(id, name)";

export async function GET(request: NextRequest) {
  const ctx = await requireManualTaskContext();
  if ("error" in ctx) return ctx.error;
  const { organizationId, admin } = ctx;

  const raw = (request.nextUrl.searchParams.get("status") || "open").toLowerCase();
  const status = VALID_FILTERS.has(raw) ? raw : "open";

  let q = admin
    .from("manual_tasks")
    .select(SELECT)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(LIST_CAP);
  if (status !== "all") q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data ?? [] });
}
