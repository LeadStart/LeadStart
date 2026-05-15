// Public FAQ chatbot endpoint for the LeadStart.io marketing site.
//
// The embeddable widget (public/site-chat.js) POSTs the conversation here.
// We answer with Claude Haiku, using the curated knowledge document in
// src/lib/site-chat/knowledge.ts as a CACHED system prompt so repeat turns
// pay ~0.1x for the (large, stable) background.
//
// This is a PUBLIC, unauthenticated endpoint living on a different origin
// than the widget (widget runs on leadstart.io, API runs on the app
// domain). So it carries its own guards: an origin allowlist, a basic
// per-IP rate limit, and hard caps on conversation size + output tokens
// so nobody can run up the Anthropic bill.

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, MissingAnthropicKeyError } from "@/lib/ai/client";
import { SITE_CHAT_SYSTEM_PROMPT } from "@/lib/site-chat/knowledge";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 800; // FAQ answers are short; this also caps cost.

// Conversation-size guards. A visitor can't POST a giant fabricated
// history to burn tokens.
const MAX_TURNS = 24;
const MAX_CHARS_PER_MESSAGE = 4000;

// Best-effort per-IP rate limit. NOTE: this Map lives in the serverless
// instance's memory, so it's per-instance, not global — good enough to
// blunt a single IP hammering a warm instance for an MVP. The documented
// upgrade path is a shared store (Supabase table or Upstash) if abuse
// becomes real.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;
const ipHits = new Map<string, number[]>();

// Origins allowed to call this endpoint. Override in env with a
// comma-separated list (SITE_CHAT_ALLOWED_ORIGINS) once the real
// marketing domain is final. localhost is included so the widget can be
// tested locally.
const DEFAULT_ALLOWED_ORIGINS = [
  "https://leadstart.io",
  "https://www.leadstart.io",
  "http://localhost:3000",
];

function allowedOrigins(): string[] {
  const env = process.env.SITE_CHAT_ALLOWED_ORIGINS;
  if (!env) return DEFAULT_ALLOWED_ORIGINS;
  return env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && allowedOrigins().includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function clientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (ipHits.get(ip) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS
  );
  recent.push(now);
  ipHits.set(ip, recent);
  // Opportunistic cleanup so the Map can't grow unbounded.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => now - t >= RATE_WINDOW_MS)) ipHits.delete(k);
    }
  }
  return recent.length > RATE_MAX;
}

type InboundMessage = { role: "user" | "assistant"; content: string };

function parseMessages(body: unknown): InboundMessage[] | { error: string } {
  if (typeof body !== "object" || body === null || !("messages" in body)) {
    return { error: "Expected a { messages: [...] } body." };
  }
  const raw = (body as { messages: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: "messages must be a non-empty array." };
  }
  if (raw.length > MAX_TURNS) {
    return { error: `Conversation too long (max ${MAX_TURNS} messages).` };
  }
  const out: InboundMessage[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) {
      return { error: "Each message must be an object." };
    }
    const role = (m as { role?: unknown }).role;
    const content = (m as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") {
      return { error: "Each message.role must be 'user' or 'assistant'." };
    }
    if (typeof content !== "string" || !content.trim()) {
      return { error: "Each message.content must be a non-empty string." };
    }
    if (content.length > MAX_CHARS_PER_MESSAGE) {
      return {
        error: `A message exceeds the ${MAX_CHARS_PER_MESSAGE}-character limit.`,
      };
    }
    out.push({ role, content: content.trim() });
  }
  // The Messages API requires the first turn to be from the user, and a
  // chat only makes sense if the latest turn is the visitor's question.
  if (out[0]!.role !== "user") {
    return { error: "Conversation must start with a user message." };
  }
  if (out[out.length - 1]!.role !== "user") {
    return { error: "The last message must be from the user." };
  }
  return out;
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);

  // If the request carries an Origin (i.e. it's a browser cross-site
  // call) it must be on the allowlist. Requests with no Origin header
  // (curl, server-to-server, same-origin) are allowed through so the
  // endpoint stays testable.
  if (origin && !allowedOrigins().includes(origin)) {
    return NextResponse.json(
      { error: "Origin not allowed." },
      { status: 403, headers: cors }
    );
  }

  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: "Too many messages — give it a moment and try again." },
      { status: 429, headers: cors }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON." },
      { status: 400, headers: cors }
    );
  }

  const parsed = parseMessages(body);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error },
      { status: 400, headers: cors }
    );
  }

  try {
    const client = getAnthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Knowledge doc is the stable prefix → cached. The conversation
      // is volatile → after the cached prefix, no cache marker.
      system: [
        {
          type: "text",
          text: SITE_CHAT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: parsed.map((m) => ({ role: m.role, content: m.content })),
    });

    const reply = response.content
      .filter(
        (b): b is Anthropic.TextBlock => b.type === "text"
      )
      .map((b) => b.text)
      .join("")
      .trim();

    if (!reply) {
      // Refusal or empty completion — don't echo nothing back.
      return NextResponse.json(
        {
          reply:
            "Sorry, I can't help with that one. I can answer questions about LeadStart though — what would you like to know?",
        },
        { headers: cors }
      );
    }

    return NextResponse.json({ reply }, { headers: cors });
  } catch (err) {
    if (err instanceof MissingAnthropicKeyError) {
      console.error("[site-chat] ANTHROPIC_API_KEY missing");
      return NextResponse.json(
        { error: "Chat is temporarily unavailable." },
        { status: 503, headers: cors }
      );
    }
    if (
      err instanceof Anthropic.RateLimitError ||
      err instanceof Anthropic.InternalServerError
    ) {
      console.error("[site-chat] Anthropic transient error:", err);
      return NextResponse.json(
        { error: "I'm a bit busy right now — try again in a moment." },
        { status: 503, headers: cors }
      );
    }
    console.error("[site-chat] Unexpected error:", err);
    return NextResponse.json(
      { error: "Something went wrong. Please try again." },
      { status: 502, headers: cors }
    );
  }
}
