// POST /api/admin/salesforge/products — returns the product list for a
// given workspace. Used by the Settings page to populate the default-
// product dropdown once a workspace has been picked. Owner-only.
//
// Body: { api_key: string, workspace_id: string }
// Returns 200 { products: [{ id, name }] }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
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
