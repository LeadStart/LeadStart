// POST /api/admin/salesforge/workspaces — returns the workspace list for
// a given Salesforge API key. Used by the Settings page to populate the
// workspace dropdown after the key is entered. Owner-only.
//
// Body: { api_key: string }
// Returns 200 { workspaces: [{ id, name }] }.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SalesforgeClient } from "@/lib/salesforge/client";

interface WorkspacesBody {
  api_key?: string;
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

  let body: WorkspacesBody;
  try {
    body = (await req.json()) as WorkspacesBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "api_key is required" }, { status: 400 });
  }

  try {
    const client = new SalesforgeClient(apiKey);
    const workspaces = await client.listWorkspaces();
    return NextResponse.json({ workspaces });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Failed to load workspaces: ${message}` },
      { status: 400 },
    );
  }
}
