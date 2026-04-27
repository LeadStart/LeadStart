import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { HAIKU_MODEL_ID } from "@/lib/decision-maker/pricing";

// POST /api/admin/prospecting/validate-anthropic
//
// Body: { api_key: string }
//
// No auth check — the user is testing a key they just typed in their own
// settings page. Mirrors validate-key/route.ts:10-12 for Scrap.io.
//
// Validates by firing a 4-token Haiku call. If it succeeds, the key works
// and has Haiku access. If it fails (401, 403, network), we surface the
// SDK's error message to the UI.

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { api_key?: unknown };
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";

  if (!apiKey) {
    return NextResponse.json({ error: "api_key required" }, { status: 400 });
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    await anthropic.messages.create({
      model: HAIKU_MODEL_ID,
      max_tokens: 4,
      messages: [{ role: "user", content: "ping" }],
    });
    return NextResponse.json({ success: true, model: HAIKU_MODEL_ID });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
