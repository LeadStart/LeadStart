// POST /api/admin/warmforge/test — validates a Warmforge API key by
// calling GET /mailboxes?page=1&page_size=1. Owner-only.
//
// Body: { api_key: string }
// Returns 200 { success: true } on a successful upstream call,
// 400 with the upstream error message otherwise.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { WarmforgeClient } from "@/lib/warmforge/client";

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
    const client = new WarmforgeClient(apiKey);
    await client.listMailboxes(1, 1);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Warmforge rejected the key: ${message}` },
      { status: 400 },
    );
  }
}
