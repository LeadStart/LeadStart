// /api/admin/salesforge/products
//
// POST: returns the product list for a workspace, given an arbitrary
// api_key + workspace_id in the request body. Used by the Settings
// page during the initial setup flow (before the key is saved).
//
// GET: returns the product list using the org's saved Salesforge key
// + workspace. Used by the sequence creator UI (and any other surface
// that just wants "the org's products"). Easier to call than POST
// because the caller doesn't need to know or pass the key.
//
// Both forms are owner-only and return { products: [{ id, name }] }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SalesforgeClient } from "@/lib/salesforge/client";

interface ProductsBody {
  api_key?: string;
  workspace_id?: string;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  let body: ProductsBody;
  try {
    body = (await req.json()) as ProductsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  const workspaceId =
    typeof body.workspace_id === "string" ? body.workspace_id.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "api_key is required" }, { status: 400 });
  }
  if (!workspaceId) {
    return NextResponse.json({ error: "workspace_id is required" }, { status: 400 });
  }

  try {
    const client = new SalesforgeClient(apiKey);
    const products = await client.listProducts(workspaceId);
    return NextResponse.json({ products });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to load products: ${message}` },
      { status: 400 },
    );
  }
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }
  const organizationId = user.app_metadata?.organization_id;
  if (!organizationId) {
    return NextResponse.json({ error: "No organization on user" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orgData } = await admin
    .from("organizations")
    .select("salesforge_api_key, salesforge_workspace_id")
    .eq("id", organizationId)
    .maybeSingle();
  const org = orgData as
    | { salesforge_api_key: string | null; salesforge_workspace_id: string | null }
    | null;
  if (!org?.salesforge_api_key || !org.salesforge_workspace_id) {
    return NextResponse.json(
      { error: "Salesforge API key or workspace not configured." },
      { status: 400 },
    );
  }

  try {
    const client = new SalesforgeClient(org.salesforge_api_key);
    const products = await client.listProducts(org.salesforge_workspace_id);
    return NextResponse.json({ products });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to load products: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
