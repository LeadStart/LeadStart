// POST /api/admin/ai/spintax
//
// Owner-only. Takes campaign copy the owner wrote and asks Claude Haiku to
// rewrite it with meaning-equivalent spintax alternatives ({a|b|c}). The
// owner reviews the before/after in the builder and explicitly accepts —
// this route never persists anything.
//
// Request:  { subject: string | null, body: string }
// Success:  { subject: string | null, body: string }   (the spintaxed rewrite)
// Error:    { error: string }   (non-200)
//
// Not campaign-scoped: the new-campaign builders have no campaign id yet.

import { NextResponse } from "next/server";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { getAnthropic } from "@/lib/ai/client";
import { SPINTAX_SYSTEM_PROMPT } from "@/lib/ai/prompts/spintax-system";
import { HAIKU_MODEL_ID } from "@/lib/decision-maker/pricing";
import { parseSpintax } from "@/lib/spintax";

export const runtime = "nodejs";

const MERGE_TAG_RE = /\{\{[^}]+\}\}/g;

/** Multiset of merge tags in a string, as a sorted array for equality checks. */
function mergeTags(text: string): string[] {
  return (text.match(MERGE_TAG_RE) ?? []).sort();
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True if parsing produced a structural spintax warning we must reject. */
function hasBlockingWarning(template: string): boolean {
  const { warnings } = parseSpintax(template);
  return warnings.some(
    (w) => w.code === "unbalanced_brace" || w.code === "token_in_spintax",
  );
}

const SpintaxRewriteSchema = z.object({
  subject: z
    .string()
    .nullable()
    .describe("Subject rewritten with spintax, or null if none was provided."),
  body: z.string().describe("Body rewritten with spintax alternatives."),
});

export async function POST(request: Request) {
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.app_metadata?.role !== "owner") {
    return NextResponse.json({ error: "Owner role required" }, { status: 403 });
  }

  let payload: { subject?: string | null; body?: string };
  try {
    payload = (await request.json()) as { subject?: string | null; body?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const subject =
    payload.subject === undefined || payload.subject === null
      ? null
      : payload.subject;
  const body = payload.body;

  if (typeof body !== "string" || body.trim().length === 0) {
    return NextResponse.json({ error: "Body is required." }, { status: 400 });
  }
  if (body.length > 5000) {
    return NextResponse.json(
      { error: "Body is too long (max 5000 characters)." },
      { status: 400 },
    );
  }
  if (subject !== null) {
    if (typeof subject !== "string") {
      return NextResponse.json({ error: "Subject must be text." }, { status: 400 });
    }
    if (subject.length > 500) {
      return NextResponse.json(
        { error: "Subject is too long (max 500 characters)." },
        { status: 400 },
      );
    }
  }

  let output: { subject: string | null; body: string };
  try {
    const client = getAnthropic();
    const response = await client.messages.parse({
      model: HAIKU_MODEL_ID,
      max_tokens: 2048,
      system: [
        {
          type: "text",
          text: SPINTAX_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: `# Subject\n${subject ?? "(none)"}\n\n# Body\n${body}`,
        },
      ],
      output_config: {
        format: zodOutputFormat(SpintaxRewriteSchema),
      },
    });

    if (!response.parsed_output) {
      return NextResponse.json(
        { error: "The AI produced no output — try again." },
        { status: 502 },
      );
    }
    output = response.parsed_output;
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Post-validation (no retry loop):
  // (a) the set of {{...}} merge tags must be preserved exactly.
  const inputTags = mergeTags(`${subject ?? ""}\n${body}`);
  const outputTags = mergeTags(`${output.subject ?? ""}\n${output.body}`);
  if (!sameTags(inputTags, outputTags)) {
    return NextResponse.json(
      { error: "The AI produced invalid spintax — try again." },
      { status: 502 },
    );
  }

  // (b) the rewrite must parse without structural spintax errors.
  if (
    hasBlockingWarning(output.subject ?? "") ||
    hasBlockingWarning(output.body)
  ) {
    return NextResponse.json(
      { error: "The AI produced invalid spintax — try again." },
      { status: 502 },
    );
  }

  return NextResponse.json({ subject: output.subject, body: output.body });
}
