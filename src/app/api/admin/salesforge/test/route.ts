// POST /api/admin/salesforge/test — validates a Salesforge API key by
// calling GET /me. Owner-only.
//
// Body: { api_key: string }
// Returns 200 { success: true, me } on a successful upstream call,
// 400 with the upstream error message otherwise.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SalesforgeClient } from "@/lib/salesforge/client";

interface TestBody {
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

  let body: TestBody;
  try {
    body = (await req.json()) as TestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ error: "api_key is required" }, { status: 400 });
  }

  try {
    const client = new SalesforgeClient(apiKey);
    const me = await client.getMe();
    return NextResponse.json({ success: true, me });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Salesforge rejected the key: ${message}` },
      { status: 400 },
    );
  }
}
