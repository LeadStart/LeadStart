import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_LAYER2_MODEL } from "@/lib/decision-maker/pricing";

// POST /api/admin/prospecting/validate-perplexity
//
// Body: { api_key: string }
//
// No auth check — the user is testing a key they just typed in their own
// settings page. Validates by firing a tiny Sonar chat completion.

export const maxDuration = 15;

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => ({}))) as { api_key?: unknown };
  const apiKey = typeof body.api_key === "string" ? body.api_key.trim() : "";

  if (!apiKey) {
    return NextResponse.json({ error: "api_key required" }, { status: 400 });
  }

  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_LAYER2_MODEL,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: `Perplexity ${response.status}: ${errText.slice(0, 200)}` },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, model: DEFAULT_LAYER2_MODEL });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
