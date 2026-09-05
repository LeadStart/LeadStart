// GET  /api/admin/workspaces: list the org's Google Workspaces (for the setup
//                              picker). Never returns secrets.
// POST /api/admin/workspaces: add a Workspace (label + super-admin email, plus
//                              an optional license SKU). The tenant's admin must
//                              separately authorize the service account's client
//                              ID (the DWD step) for provisioning to actually run.
// Owner only, org-scoped.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOwner } from "@/lib/auth/require-owner";
import type { GoogleWorkspace } from "@/types/app";

export async function GET() {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const admin = createAdminClient();
  const { data } = await admin
    .from("google_workspaces")
    .select("id, label, admin_email, is_default, license_product_id, license_sku_id, created_at")
    .eq("organization_id", organizationId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });

  return NextResponse.json({ workspaces: (data ?? []) as Partial<GoogleWorkspace>[] });
}

interface CreateBody {
  label?: string;
  admin_email?: string;
  license_product_id?: string;
  license_sku_id?: string;
}

export async function POST(req: NextRequest) {
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { organizationId } = auth;

  const body = (await req.json().catch(() => null)) as CreateBody | null;
  const label = (body?.label ?? "").trim();
  const adminEmail = (body?.admin_email ?? "").trim().toLowerCase();
  if (!label) {
    return NextResponse.json({ error: "A Workspace name is required." }, { status: 400 });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    return NextResponse.json({ error: "A valid Workspace admin email is required." }, { status: 400 });
  }

  const admin = createAdminClient();
  // First Workspace for the org becomes the default.
  const { count } = await admin
    .from("google_workspaces")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  const { data, error } = await admin
    .from("google_workspaces")
    .insert({
      organization_id: organizationId,
      label,
      admin_email: adminEmail,
      license_product_id: body?.license_product_id?.trim() || null,
      license_sku_id: body?.license_sku_id?.trim() || null,
      is_default: (count ?? 0) === 0,
    })
    .select("id, label, admin_email, is_default")
    .single();
  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "That admin email is already a Workspace here." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ workspace: data });
}
