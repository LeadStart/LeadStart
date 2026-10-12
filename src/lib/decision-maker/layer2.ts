// Layer 2: web-search decision-maker lookup.
//
// Claude Haiku 5.5 with ONE web search, on the org's Anthropic key (owner
// decision 2026-10-11; Perplexity Sonar was Layer 2's only engine from
// 2026-08-28). Measured on 105 cleaning firms whose own site named nobody:
// Perplexity named 11 and 4 became confirmed contacts (16.9¢ each, lookup +
// Million Verifier); Claude with one search named 52 and 17 became confirmed
// contacts (9.3¢ each). A lookup costs ~1.2¢: the 1¢ search fee is most of it,
// ~13K tokens of search results the rest. Triggered only when Layer 1 returns
// no first_name and the caller set useLayer2 (the naming phase skips firms
// where no contact could be confirmed, see layer2CanYieldContact).
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
import { LAYER2_MODEL_ID, WEB_SEARCH_COST_USD, calculateCost } from "./pricing";
import type { MailHost } from "../enrichment/mail-host";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

// The instruction the Perplexity call used, so answers stay a bare JSON object.
const SYSTEM_PROMPT =
  "You are a business research assistant. Return ONLY valid JSON, no markdown, no explanation, no preamble.";
// One search per business: the search fee is ~86% of a lookup's cost, and up
// to 3 searches confirmed 18 contacts where one confirmed 17 (2026-10-11), at
// 2.3× the cost per lookup.
const MAX_SEARCHES = 1;
// Haiku 5.5 thinks before answering; the answer itself is a short JSON object.
const MAX_TOKENS = 8_000;
// A long search can pause the turn (stop_reason "pause_turn"); resume at most this often.
const MAX_CONTINUATIONS = 2;
// Per request; the per-business limit (30 s in the naming phase) still bounds the lookup.
const REQUEST_TIMEOUT_MS = 25_000;

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

// Whether a Layer 2 name could become a contact we can confirm: pattern_mv
// guesses first.last@ the firm's domain and Million Verifier checks it, so it
// takes a domain with a mail server. An unchecked mail host (null) counts as
// yes. In the 2026-10-11 test, 20 of 105 lookups were on firms that failed this.
export function layer2CanYieldContact(domain: string | null | undefined, mailHost: MailHost | null): boolean {
  return Boolean(domain?.trim()) && mailHost !== "none";
}

export async function enrichWithWebSearch(
  input: EnrichmentInput,
  opts: EnrichmentOptions,
): Promise<EnrichmentResult> {
  const prompt = DEFAULT_LAYER2_PROMPT
    .replace(/\{business_name\}/g, input.business_name)
    .replace(/\{website\}/g, input.website || "unknown")
    .replace(/\{city\}/g, (input.city || "").trim())
    .replace(/\{state\}/g, (input.state || "").trim())
    .replace(/\{page_text\}/g, "")
    .replace(/\{category\}/g, (input.category || "General").trim())
    .replace(/\{seniority_priority\}/g, getSeniorityPriority(input.category || "", opts.serviceType))
    .replace(/\{skip_roles\}/g, getSkipRoles(input.category || "", opts.serviceType));

  // Search from where the business is, so local listings (BBB, Yelp, state
  // records) outrank same-named firms elsewhere.
  const city = (input.city || "").trim();
  const state = (input.state || "").trim();
  const webSearch: Anthropic.WebSearchTool20250305 = {
    type: "web_search_20250305",
    name: "web_search",
    max_uses: MAX_SEARCHES,
    user_location: { type: "approximate", country: "US", ...(city ? { city } : {}), ...(state ? { region: state } : {}) },
  };

  const anthropic = new Anthropic({ apiKey: opts.anthropicKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  let messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const content: Anthropic.ContentBlock[] = [];
  let searches = 0;
  let cost = 0;
  try {
    for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
      const res = await anthropic.messages.create({
        model: LAYER2_MODEL_ID,
        max_tokens: MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages,
        tools: [webSearch],
        output_config: { effort: "medium" },
      });
      const used = res.usage.server_tool_use?.web_search_requests ?? 0;
      searches += used;
      cost +=
        calculateCost({ input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, LAYER2_MODEL_ID) +
        used * WEB_SEARCH_COST_USD;
      content.push(...res.content);
      if (res.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: res.content }];
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A request the account rejects (web search off in the Claude Console, a bad
    // or under-scoped key) fails the same way on every retry, and each retry
    // would pay for Layer 1 again: record it and finish. Rate limits, 5xx and
    // timeouts stay retryable.
    if (err instanceof Anthropic.APIError && err.status && err.status >= 400 && err.status < 500 && err.status !== 429) {
      return EMPTY(`Web search unavailable (HTTP ${err.status}): ${message}`.slice(0, 300), "complete", cost);
    }
    return EMPTY(`Web search error: ${message}`, "error", cost);
  }

  let firstName: string | null = null;
  let lastName: string | null = null;
  let title: string | null = null;
  let personalEmail: string | null = null;
  const otherEmails: string[] = [];

  const responseText = content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
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
    } catch {
      // Not JSON after all: no name.
    }
  }

  return {
    first_name: firstName,
    last_name: lastName,
    title,
    personal_email: personalEmail,
    other_emails: otherEmails,
    enrichment_source: firstName ? "web_search" : null,
    enrichment_notes: `Claude web search (${searches} search${searches === 1 ? "" : "es"})`,
    status: "complete",
    cost_usd: cost,
  };
}
