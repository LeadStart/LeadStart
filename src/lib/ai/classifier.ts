// Claude Haiku 4.5 classifier — Layer 2 of the three-layer reply-routing
// classifier (plan: docs/plans/ai-reply-routing.md).
//
// Called after the deterministic keyword prefilter (Layer 1). Its job is to
// verify / override Instantly's native tag using a structured Haiku call
// with the full taxonomy. Output is merged with Instantly's tag and the
// prefilter's output inside src/lib/replies/decide.ts (Layer 3) to produce
// `final_class`.

import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { getAnthropic } from "./client";
import { CLASSIFIER_SYSTEM_PROMPT } from "./prompts/classifier-system";
import type { ReplyClass } from "@/types/app";
import type { PrefilterResult } from "@/lib/replies/keyword-prefilter";

// Runtime Zod schema. Kept in sync with the ReplyClass union in
// src/types/app.ts — drift here breaks classifier output validation.
const REPLY_CLASS_VALUES = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "objection_price",
  "objection_timing",
  "referral_forward",
  "wrong_person_no_referral",
  "ooo",
  "not_interested",
  "unsubscribe",
  "needs_review",
] as const satisfies readonly ReplyClass[];

const ReferralContactSchema = z
  .object({
    email: z
      .string()
      .nullable()
      .describe("Referral contact's email address if present in the body, otherwise null."),
    name: z.string().nullable().describe("Referral contact's name if given, otherwise null."),
    title: z.string().nullable().describe("Referral contact's role or title if stated, otherwise null."),
  })
  .nullable();

const ClassifierOutputSchema = z.object({
  class: z.enum(REPLY_CLASS_VALUES).describe(
    "The single best class for this reply, drawn from the LeadStart taxonomy."
  ),
  confidence: z
    .number()
    .describe("Confidence in the chosen class, scored 0.0-1.0."),
  reason: z
    .string()
    .describe("One-line justification citing the specific textual evidence."),
  referral_contact: ReferralContactSchema.describe(
    "When class = referral_forward, the extracted handoff target. Null for all other classes."
  ),
});

export type ClassifierOutput = z.infer<typeof ClassifierOutputSchema>;

export interface ClassifierInput {
  body: string;                      // plain-text reply body
  instantly_category?: string | null; // raw Instantly event name if present
  prefilter?: PrefilterResult;        // output of keyword-prefilter.ts
  persona_name?: string | null;       // real name on the outreach side (Path 1)
}

// Model + limits. Kept here so they're one spot to tune.
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 512;

/**
 * Build the user-turn text from the inputs. We keep the rendering logic
 * here (not in the system prompt) so all volatile per-request content
 * sits after the cached prefix.
 */
function renderUserMessage(input: ClassifierInput): string {
  const lines: string[] = [];
  lines.push("# Reply body");
  lines.push(input.body.trim() || "(empty body)");
  lines.push("");
  lines.push("# Instantly native tag (optional)");
  lines.push(input.instantly_category || "none");
  lines.push("");

  lines.push("# Prefilter signals (optional)");
  if (input.prefilter) {
    lines.push(
      `flags: ${input.prefilter.flags.length > 0 ? input.prefilter.flags.join(", ") : "none"}`
    );
    lines.push(`suggested_class: ${input.prefilter.suggested_class ?? "none"}`);
    lines.push(
      `embedded_emails: ${
        input.prefilter.embedded_emails.length > 0
          ? input.prefilter.embedded_emails.join(", ")
          : "none"
      }`
    );
  } else {
    lines.push("flags: none");
    lines.push("suggested_class: none");
    lines.push("embedded_emails: none");
  }
  lines.push("");

  lines.push("# Outreach persona (optional)");
  lines.push(input.persona_name || "unknown");

  return lines.join("\n");
}

/**
 * Run the Haiku classifier. Throws on network / API errors and on
 * validation errors (Zod schema mismatch between Claude's output and
 * ClassifierOutputSchema — should never happen if the enum stays in sync
 * with ReplyClass).
 *
 * @param input - reply body + optional enrichment
 * @returns structured classification result
 */
export async function classifyReply(input: ClassifierInput): Promise<ClassifierOutput> {
  const client = getAnthropic();

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Cache the (large) system prompt so repeat calls pay 0.1x.
    system: [
      {
        type: "text",
        text: CLASSIFIER_SYSTEM_PROMPT,
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
      format: zodOutputFormat(ClassifierOutputSchema),
    },
  });

  if (!response.parsed_output) {
    throw new Error(
      `Classifier returned no parsed output. stop_reason=${response.stop_reason}`
    );
  }

  // If class isn't referral_forward, scrub any referral_contact the
  // model accidentally filled. Keeps downstream code simpler.
  const out = response.parsed_output;
  if (out.class !== "referral_forward" && out.referral_contact) {
    out.referral_contact = null;
  }

  return out;
}

// Exposed for tests / fixtures that want to assert the schema shape.
export { ClassifierOutputSchema, REPLY_CLASS_VALUES };
