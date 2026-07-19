import { NextRequest, NextResponse } from "next/server";
import { InstantlyClient } from "@/lib/instantly/client";

// Validate an Instantly API key. Mirrors /api/admin/unipile/test: the key is
// one the user just typed into their own settings page, so there's nothing to
// leak — no auth gate, just echo-and-test.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const apiKey = (body as { api_key?: unknown }).api_key;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return NextResponse.json({ error: "API key required" }, { status: 400 });
  }

  const client = new InstantlyClient(apiKey.trim());
  const success = await client.testConnection();
  if (success) {
    return NextResponse.json({ success: true });
  }
  return NextResponse.json({ error: "Connection failed" }, { status: 400 });
}
