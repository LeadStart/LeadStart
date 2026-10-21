// Pan Pal's chat endpoint for the leadstart.io website.
//
// The website's widget (assets/js/panpal.js in the LeadStart-Website repo)
// calls /app/api/site-chat through the site's /app rewrite, so on leadstart.io
// it's the same site. Every reply is an answer-book entry, word for word
// (src/lib/site-chat/answer-book.ts):
//
// - { topic }: a hello line or suggested question whose topic the widget
//   already knows. No Claude call.
// - { messages }: what the visitor typed. Claude Haiku 5.5 picks the topic
//   (src/lib/site-chat/picker.ts); it never writes the reply.
//
// This is a public, unauthenticated endpoint (the /api/ bypass in
// src/lib/supabase/middleware.ts), so it carries its own guards: an origin
// allowlist for browser calls, the shared rate limiter (the rate_limits table,
// so every instance counts together), and caps on message size and
// conversation length. A question no answer covers goes to the owner-alert
// queue (one digest email every 5 minutes), so Daniel can add an answer.

import { NextRequest, NextResponse, after } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { MissingAnthropicKeyError } from "@/lib/ai/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueOwnerAlert } from "@/lib/notifications/owner-alerts";
import { checkRateLimit, checkRateLimits, clientIp } from "@/lib/security/rate-limit";
import { BOOK_VERSION, answerFor, isTopicId, type TopicId } from "@/lib/site-chat/answer-book";
import { pickTopics, type ChatTurn } from "@/lib/site-chat/picker";

// Conversation-size guards: a visitor can't post a giant made-up history to
// burn tokens. Pan Pal's own answers run to about 400 characters.
const MAX_TURNS = 24;
const MAX_VISITOR_CHARS = 1000;
const MAX_ANY_CHARS = 2000;

// Origins allowed to call this endpoint from a browser. Override in env with a
// comma-separated list (SITE_CHAT_ALLOWED_ORIGINS), e.g. to test the widget
// from a local copy of the website.
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

type Parsed = { topic: TopicId } | { conversation: ChatTurn[] } | { error: string };

/**
 * The request: `{ topic }`, or `{ messages }` with the visitor's turns as role "visitor" and Pan Pal's as "pan_pal"
 * (the older widget's "user" and "assistant", with `content`, are read the same way). The last turn must be the
 * visitor's.
 */
function parseBody(body: unknown): Parsed {
  if (typeof body !== "object" || body === null) return { error: "Expected a JSON object." };
  const topic = (body as { topic?: unknown }).topic;
  if (topic !== undefined) return isTopicId(topic) ? { topic } : { error: "Unknown topic." };

  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Expected { topic } or a non-empty { messages }." };
  if (raw.length > MAX_TURNS) return { error: `Conversation too long (max ${MAX_TURNS} messages).` };

  const conversation: ChatTurn[] = [];
  for (const m of raw) {
    if (typeof m !== "object" || m === null) return { error: "Each message must be an object." };
    const r = (m as { role?: unknown }).role;
    const role = r === "visitor" || r === "user" ? "visitor" : r === "pan_pal" || r === "assistant" ? "pan_pal" : null;
    if (!role) return { error: "Each message.role must be 'visitor' or 'pan_pal'." };
    const t = (m as { text?: unknown; content?: unknown }).text ?? (m as { content?: unknown }).content;
    if (typeof t !== "string" || !t.trim()) return { error: "Each message needs non-empty text." };
    const cap = role === "visitor" ? MAX_VISITOR_CHARS : MAX_ANY_CHARS;
    if (t.length > cap) return { error: `A message exceeds the ${cap}-character limit.` };
    conversation.push({ role, text: t.trim() });
  }
  if (conversation[conversation.length - 1]!.role !== "visitor") {
    return { error: "The last message must be the visitor's." };
  }
  return { conversation };
}

function reply(topics: TopicId[], cors: Record<string, string>, extra: Record<string, unknown> = {}) {
  const replies = topics.map((id) => {
    const a = answerFor(id);
    return { topic: a.id, text: a.text, links: a.links };
  });
  // `reply` keeps the older widget (src/app/site-chat.js) working: it reads one string.
  return NextResponse.json(
    { replies, reply: replies.map((r) => r.text).join("\n\n"), version: BOOK_VERSION, ...extra },
    { headers: cors },
  );
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

  // A browser call (it carries an Origin) must come from an allowed site.
  // Calls with no Origin (curl, server-to-server) go through, so the endpoint
  // stays testable; the rate limits below still apply to them.
  if (origin && !allowedOrigins().includes(origin)) {
    return NextResponse.json({ error: "Origin not allowed." }, { status: 403, headers: cors });
  }

  const ip = clientIp(request);
  const limit = await checkRateLimits([
    { bucket: `site-chat:ip:${ip}`, limit: 20, windowSeconds: 60 },
    { bucket: `site-chat:ip-day:${ip}`, limit: 300, windowSeconds: 86_400 },
  ]);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many messages, give it a moment and try again." },
      { status: 429, headers: { ...cors, "Retry-After": String(Math.max(1, Math.ceil(limit.retryAfterSeconds))) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400, headers: cors });
  }

  const parsed = parseBody(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  if ("topic" in parsed) return reply([parsed.topic], cors);

  const question = parsed.conversation[parsed.conversation.length - 1]!.text;
  try {
    const pick = await pickTopics(parsed.conversation);
    // A refusal or an unreadable pick gets the fixed "I can't answer that one" reply.
    const topics: TopicId[] = pick.ok ? pick.topics : ["unknown"];
    if (!pick.ok) console.warn(`[site-chat] pick failed (${pick.reason})`);

    // Local dev points at the production database, so a test question there
    // never reaches the owners' digest.
    if (topics.includes("unknown") && process.env.NODE_ENV !== "development") {
      // Queue the question for Daniel once the reply is out. At most 5 a day
      // from one visitor, so nobody can flood the digest.
      after(async () => {
        const allowed = await checkRateLimit({ bucket: `site-chat:alert:${ip}`, limit: 5, windowSeconds: 86_400 });
        if (!allowed.allowed) return;
        await enqueueOwnerAlert({
          admin: createAdminClient(),
          kind: "site_chat_unanswered",
          subject: "Pan Pal couldn't answer a website visitor",
          summary: `A visitor asked: "${question.slice(0, 300)}"`,
          context: { question: question.slice(0, MAX_VISITOR_CHARS), answerBook: BOOK_VERSION },
        });
      });
    }
    return reply(topics, cors);
  } catch (err) {
    // Claude unreachable or misconfigured: the visitor still gets an approved
    // answer (the way to reach Daniel), never an error message.
    if (err instanceof MissingAnthropicKeyError) console.error("[site-chat] ANTHROPIC_API_KEY missing");
    else if (err instanceof Anthropic.APIError) console.error(`[site-chat] Anthropic error ${err.status}:`, err.message);
    else console.error("[site-chat] Unexpected error:", err);
    return reply(["unknown"], cors, { degraded: true });
  }
}
