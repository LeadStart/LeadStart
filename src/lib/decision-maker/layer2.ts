// Layer 2 — web-search decision-maker fallback.
//
// Triggered only when Layer 1 returns no first_name and the run was
// configured with use_layer2=true. Uses Perplexity Sonar by default
// (cheap, real-time citations); falls back to Claude's web_search tool if
// no Perplexity key is configured.
//
// Ported from server/enricher.ts:347-440 of the LeadEnrich reference build.

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_LAYER2_PROMPT } from "./prompts";
import {
  isPersonalEmail,
  isJunkEmail,
  emailMatchesName,
  validateAiResult,
} from "./validation";
import { getSeniorityPriority, getSkipRoles } from "./seniority-maps";
import {
  calculateCost,
  HAIKU_MODEL_ID,
  DEFAULT_LAYER2_MODEL,
  isPerplexityModel,
} from "./pricing";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

interface PerplexityCallResult {
  text: string;
  cost: number;
}

interface PerplexityResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function callPerplexity(
  apiKey: string,
  prompt: string,
  model: string,
): Promise<PerplexityCallResult> {
  const response = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are a business research assistant. Return ONLY valid JSON, no markdown, no explanation, no preamble.",
        },
        { role: "user", content: prompt },
      ],
      max_tokens: 200,
      temperature: 0.1,
      return_citations: true,
      search_recency_filter: "year",
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Perplexity API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as PerplexityResponse;
  const text = data.choices?.[0]?.message?.content || "";
  const usage = data.usage || {};
  const cost = calculateCost(
    {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
    },
    model,
  );
  return { text, cost };
}

export async function enrichWithWebSearch(
  input: EnrichmentInput,
  opts: EnrichmentOptions,
): Promise<EnrichmentResult> {
  // Pick layer-2 path: Perplexity Sonar if a key is configured, otherwise
  // fall back to Claude's web_search tool.
  const layer2Model = opts.perplexityKey ? DEFAULT_LAYER2_MODEL : "claude-web-search";

  const prompt = DEFAULT_LAYER2_PROMPT
    .replace(/\{business_name\}/g, input.business_name)
    .replace(/\{website\}/g, input.website || "unknown")
    .replace(/\{city\}/g, (input.city || "").trim())
    .replace(/\{state\}/g, (input.state || "").trim())
    .replace(/\{page_text\}/g, "")
    .replace(/\{category\}/g, (input.category || "General").trim())
    .replace(/\{seniority_priority\}/g, getSeniorityPriority(input.category || "", opts.serviceType))
    .replace(/\{skip_roles\}/g, getSkipRoles(input.category || "", opts.serviceType));

  let firstName: string | null = null;
  let lastName: string | null = null;
  let title: string | null = null;
  let personalEmail: string | null = null;
  const otherEmails: string[] = [];
  let cost = 0;
  let notes = "";

  try {
    let responseText = "";

    if (isPerplexityModel(layer2Model) && opts.perplexityKey) {
      const result = await callPerplexity(opts.perplexityKey, prompt, layer2Model);
      responseText = result.text;
      cost += result.cost;
    } else {
      const anthropic = new Anthropic({ apiKey: opts.anthropicKey });
      const message = await anthropic.messages.create({
        model: HAIKU_MODEL_ID,
        max_tokens: 4096,
        // Claude's first-party web search tool — opts the model into
        // grounded answers without us standing up our own search index.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: [{ type: "web_search_20250305" } as any],
        messages: [{ role: "user", content: prompt }],
      });
      cost += calculateCost(
        { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
        HAIKU_MODEL_ID,
      );
      // The web_search tool can produce multiple text blocks; the final
      // text block holds the answer (preceding blocks are search planning).
      const textBlocks = message.content.filter(
        (b): b is Extract<typeof b, { type: "text" }> => b.type === "text",
      );
      const lastText = textBlocks[textBlocks.length - 1];
      responseText = lastText ? lastText.text : "";
    }

    if (responseText) {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          first_name?: string;
          last_name?: string;
          title?: string;
          email?: string;
          source?: string;
        };
        const validated = validateAiResult(parsed, input.business_name);
        if (validated.firstName && validated.lastName) {
          firstName = validated.firstName;
          lastName = validated.lastName;
          title = validated.title || null;

          const genericEmail = (input.generic_email || "").toLowerCase().trim();
          const aiEmail = validated.email.trim().toLowerCase();
          if (
            aiEmail &&
            aiEmail.includes("@") &&
            !isJunkEmail(aiEmail) &&
            aiEmail !== genericEmail &&
            isPersonalEmail(aiEmail) &&
            emailMatchesName(aiEmail, validated.firstName, validated.lastName)
          ) {
            personalEmail = aiEmail;
          } else if (aiEmail && !isJunkEmail(aiEmail)) {
            otherEmails.push(aiEmail);
          }
        }
      }
    }

    const providerLabel = isPerplexityModel(layer2Model)
      ? `Perplexity ${layer2Model}`
      : "Claude web search";
    notes = `${providerLabel} completed`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      first_name: null,
      last_name: null,
      title: null,
      personal_email: null,
      other_emails: [],
      enrichment_source: null,
      enrichment_notes: `Web search error: ${message}`,
      status: "error",
      cost_usd: cost,
    };
  }

  return {
    first_name: firstName,
    last_name: lastName,
    title,
    personal_email: personalEmail,
    other_emails: otherEmails,
    enrichment_source: firstName ? "web_search" : null,
    enrichment_notes: notes,
    status: "complete",
    cost_usd: cost,
  };
}
