// Claude Sonnet 4.6 reply drafter — fires on demand when the client taps
// "Reply via portal" in their inbox dossier (plan: docs/plans/ai-reply-routing.md).
//
// This is NOT part of the inbound classifier pipeline. It runs only when
// the client chooses the email fallback over a phone call, so we hold the
// Sonnet cost to occasions the reply is actually going to go out. The
// drafter produces { subject, body_text }; the client edits that in the
// composer and hits Send, which then calls /api/replies/[id]/send.
//
// The system prompt is static and cached. Everything volatile (the reply
// body, the class, the persona, the brand voice, the signature) goes in
// the user message so the cache prefix stays stable across regenerations.
//
// Plan reference:
//   - `src/lib/ai/prompts/drafter-system.ts` — the system prompt
//   - `src/app/api/replies/[id]/draft/route.ts` — wraps this for HTTP
//
// Failure modes: throws on network / API errors and on Zod validation
// errors (which shouldn't happen with messages.parse + zodOutputFormat).

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic } from "./client";
import { DRAFTER_SYSTEM_PROMPT } from "./prompts/drafter-system";
import type { ReplyClass } from "@/types/app";

// Classes we draft for. The classifier taxonomy has 11; the drafter only
// handles the 6 where a written response makes sense. The /draft route
// guards against passing anything else.
const DRAFTABLE_CLASSES = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "objection_timing",
  "referral_forward",
] as const satisfies readonly ReplyClass[];

export type DraftableClass = (typeof DRAFTABLE_CLASSES)[number];

export function isDraftableClass(c: string | null | undefined): c is DraftableClass {
  return !!c && (DRAFTABLE_CLASSES as readonly string[]).includes(c);
}

const DrafterOutputSchema = z.object({
  subject: z
    .string()
    .describe(
      "Reply subject line without any 'Re:' prefix. The send path adds the prefix automatically."
    ),
  body_text: z
    .string()
    .describe(
      "Plain-text reply body. Ends with a blank line followed by the signature block provided in the user message, copied verbatim."
    ),
});

export type DrafterOutput = z.infer<typeof DrafterOutputSchema>;

export interface DrafterInput {
  // The hot/warm class picked by the classifier. Drives tone and goal.
  final_class: DraftableClass;
  // Optional one-line justification from the classifier — gives the model
  // context on what specifically the prospect signalled.
  claude_reason?: string | null;

  // Prospect identity (all optional — we fall back to "unknown" in the prompt).
  lead_name?: string | null;
  lead_company?: string | null;

  // The prospect's inbound reply we're responding to.
  inbound_subject?: string | null;
  inbound_body: string;

  // Path 1 persona — the REAL client team member sending this. Never the
  // agency. Required; the draft doesn't make sense without a named sender.
  persona_name: string;
  persona_title?: string | null;

  // The client's free-form brand voice paragraph from onboarding.
  brand_voice?: string | null;

  // The client's canonical signature block. Copied verbatim into body_text.
  signature_block?: string | null;

  // Only present when final_class = 'referral_forward'. Shape matches
  // lead_replies.referral_contact.
  referral_contact?: {
    name?: string | null;
    email?: string | null;
    title?: string | null;
  } | null;
}

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 800;

function renderUserMessage(input: DrafterInput): string {
  const lines: string[] = [];

  lines.push("# Class (from classifier)");
  lines.push(input.final_class);
  lines.push("");

  lines.push("# Why it was flagged (classifier reason, optional)");
  lines.push(input.claude_reason?.trim() || "(none)");
  lines.push("");

  lines.push("# Prospect");
  lines.push(`name: ${input.lead_name?.trim() || "unknown"}`);
  lines.push(`company: ${input.lead_company?.trim() || "unknown"}`);
  lines.push("");

  lines.push("# Their inbound subject");
  lines.push(input.inbound_subject?.trim() || "(empty)");
  lines.push("");

  lines.push("# Their inbound body");
  lines.push(input.inbound_body.trim() || "(empty body)");
  lines.push("");

  lines.push("# Persona (the real sender — NOT the agency)");
  lines.push(`name: ${input.persona_name}`);
  lines.push(`title: ${input.persona_title?.trim() || ""}`);
  lines.push("");

  lines.push("# Brand voice");
  lines.push(input.brand_voice?.trim() || "(not supplied — use a warm, direct, professional tone)");
  lines.push("");

  lines.push("# Signature block");
  lines.push(input.signature_block?.trim() || `${input.persona_name}`);
  lines.push("");

  if (input.final_class === "referral_forward" && input.referral_contact) {
    lines.push("# Referral contact");
    const parts = [
      input.referral_contact.name?.trim(),
      input.referral_contact.email?.trim(),
      input.referral_contact.title?.trim(),
    ].filter(Boolean);
    lines.push(parts.length > 0 ? parts.join(" · ") : "(not supplied)");
  }

  return lines.join("\n");
}

/**
 * Run the Sonnet drafter. Throws on API errors and on parse failures.
 *
 * @param input - classifier output + persona + inbound reply
 * @returns `{ subject, body_text }` ready to hand to the composer UI
 */
export async function draftReply(input: DrafterInput): Promise<{
  output: DrafterOutput;
  model: string;
  token_usage: Record<string, unknown>;
}> {
  if (!input.persona_name?.trim()) {
    throw new Error("draftReply requires a non-empty persona_name.");
  }

  const client = getAnthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: "text",
        text: DRAFTER_SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: renderUserMessage(input),
      },
    ],
    output_config: {
      format: zodOutputFormat(DrafterOutputSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Drafter returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  return {
    output: response.parsed_output,
    model: MODEL,
    token_usage: response.usage as unknown as Record<string, unknown>,
  };
}

export { DrafterOutputSchema, DRAFTABLE_CLASSES };
