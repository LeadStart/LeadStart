import { NextRequest, NextResponse } from "next/server";
import { ScrapioClient } from "@/lib/scrapio/client";

// POST /api/admin/prospecting/validate-key
// Body: { api_key: string }
// Probes Scrap.io's /subscription endpoint with the supplied key. Returns
// the subscription payload on success so the settings UI can show plan +
// credits inline.
//
// Pattern matches /api/instantly/test — no auth check on this route. It
// only echoes back what the user just typed in their own settings page,
// so there's nothing to leak.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const apiKey = (body as { api_key?: unknown }).api_key;

  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return NextResponse.json({ error: "API key required" }, { status: 400 });
  }

  const client = new ScrapioClient(apiKey.trim());
  try {
    const subscription = await client.getSubscription();
    return NextResponse.json({ success: true, subscription });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
