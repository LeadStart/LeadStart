// Layer 2: web-search decision-maker lookup.
//
// **Perplexity Sonar ONLY** (owner directive 2026-08-28): the Claude web_search
// fallback was removed. Without a Perplexity key, Layer 2 is a no-op: the item
// stays name-less and falls through to the generic path. Triggered only when
// Layer 1 returns no first_name and the run was configured with use_layer2=true.
//
// Ported from server/enricher.ts:347-440 of the LeadEnrich reference build.

import { DEFAULT_LAYER2_PROMPT } from "./prompts";
import {
  isPersonalEmail,
  isJunkEmail,
  emailMatchesName,
  validateAiResult,
} from "./validation";
import { getSeniorityPriority, getSkipRoles } from "./seniority-maps";
import { DEFAULT_LAYER2_MODEL } from "./pricing";
import { callPerplexity } from "../perplexity/client";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

const EMPTY = (notes: string, status: EnrichmentResult["status"], cost = 0): EnrichmentResult => ({
  first_name: null,
  last_name: null,
  title: null,
  personal_email: null,
  other_emails: [],
  enrichment_source: null,
  enrichment_notes: notes,
  status,
  cost_usd: cost,
});

export async function enrichWithWebSearch(
  input: EnrichmentInput,
  opts: EnrichmentOptions,
): Promise<EnrichmentResult> {
  // Perplexity-only. No Claude web_search fallback: no key means Layer 2 does
  // not run and the item stays name-less.
  if (!opts.perplexityKey) {
    return EMPTY("Layer 2 skipped, no Perplexity key configured", "complete");
  }

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

  try {
    const result = await callPerplexity(opts.perplexityKey, prompt, DEFAULT_LAYER2_MODEL);
    const responseText = result.text;
    cost += result.cost;

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return EMPTY(`Web search error: ${message}`, "error", cost);
  }

  return {
    first_name: firstName,
    last_name: lastName,
    title,
    personal_email: personalEmail,
    other_emails: otherEmails,
    enrichment_source: firstName ? "web_search" : null,
    enrichment_notes: `Perplexity ${DEFAULT_LAYER2_MODEL} completed`,
    status: "complete",
    cost_usd: cost,
  };
}
