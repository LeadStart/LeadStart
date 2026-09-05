import { NextRequest, NextResponse } from "next/server";
import { ApifyClient } from "@/lib/apify/client";

// POST /api/admin/apify/validate-key
// Body: { api_key: string }
// Probes Apify's /users/me with the supplied token so the settings UI can show
// the account username inline. No auth check: it only echoes back what the
// user just typed into their own settings page.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const apiKey = (body as { api_key?: unknown }).api_key;

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return NextResponse.json({ error: "API token required" }, { status: 400 });
  }

  const client = new ApifyClient(apiKey.trim());
  try {
    const me = await client.getMe();
    const plan = typeof me.plan === "string" ? me.plan : me.plan?.id ?? null;
    return NextResponse.json({ success: true, username: me.username, plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
