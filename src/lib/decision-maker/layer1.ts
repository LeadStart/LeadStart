// Layer 1 — website-scrape decision-maker extraction.
//
// Fetch the business homepage + up to 4 contact/team/about pages, strip to
// plain text, ask Claude Haiku for the most senior decision maker using
// the seniority hierarchy for the business's category. Falls through with
// status='complete' and empty fields if no decision maker is found — the
// caller decides whether to escalate to Layer 2.
//
// Ported from server/enricher.ts:227-345 of the LeadEnrich reference build.

import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_LAYER1_PROMPT } from "./prompts";
import {
  isSafeUrl,
  extractEmails,
  isPersonalEmail,
  isJunkEmail,
  emailMatchesName,
  validateAiResult,
} from "./validation";
import { fetchPage, htmlToText, findContactPages } from "./fetcher";
import { getSeniorityPriority, getSkipRoles } from "./seniority-maps";
import { calculateCost, HAIKU_MODEL_ID } from "./pricing";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

function emptyResult(notes: string): EnrichmentResult {
  return {
    first_name: null,
    last_name: null,
    title: null,
    personal_email: null,
    other_emails: [],
    enrichment_source: null,
    enrichment_notes: notes,
    status: "complete",
    cost_usd: 0,
  };
}

export async function enrichWithWebsite(
  input: EnrichmentInput,
  opts: EnrichmentOptions,
): Promise<EnrichmentResult> {
  let website = input.website || "";
  if (!website) return emptyResult("No website provided");
  if (!website.startsWith("http")) website = "https://" + website;
  if (!isSafeUrl(website)) return emptyResult("Blocked: unsafe URL");

  const mainHtml = await fetchPage(website);
  if (!mainHtml) return emptyResult("Could not reach website");

  let pagesScraped = 1;
  let combinedText = htmlToText(mainHtml) + "\n";
  const allEmails: string[] = [...extractEmails(mainHtml)];

  const contactPages = findContactPages(mainHtml, website).filter(isSafeUrl);
  for (const pageUrl of contactPages) {
    try {
      const pageHtml = await fetchPage(pageUrl);
      if (pageHtml) {
        pagesScraped++;
        combinedText += htmlToText(pageHtml) + "\n";
        allEmails.push(...extractEmails(pageHtml));
      }
    } catch {
      // One bad subpage shouldn't kill enrichment.
    }
  }

  const dedupedEmails = [...new Set(allEmails)];

  let firstName: string | null = null;
  let lastName: string | null = null;
  let title: string | null = null;
  let personalEmail: string | null = null;
  let cost = 0;
  let notes = `Scraped ${pagesScraped} page${pagesScraped === 1 ? "" : "s"}, found ${dedupedEmails.length} email${dedupedEmails.length === 1 ? "" : "s"}`;

  if (combinedText.length > 50) {
    try {
      const anthropic = new Anthropic({ apiKey: opts.anthropicKey });
      const prompt = DEFAULT_LAYER1_PROMPT
        .replace(/\{business_name\}/g, input.business_name)
        .replace(/\{page_text\}/g, combinedText.substring(0, 12_000))
        .replace(/\{website\}/g, input.website || "unknown")
        .replace(/\{city\}/g, (input.city || "").trim())
        .replace(/\{state\}/g, (input.state || "").trim())
        .replace(/\{category\}/g, (input.category || "General").trim())
        .replace(/\{seniority_priority\}/g, getSeniorityPriority(input.category || "", opts.serviceType))
        .replace(/\{skip_roles\}/g, getSkipRoles(input.category || "", opts.serviceType));

      const message = await anthropic.messages.create({
        model: HAIKU_MODEL_ID,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      cost += calculateCost(
        { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
        HAIKU_MODEL_ID,
      );

      const content = message.content[0];
      if (content && content.type === "text") {
        const jsonMatch = content.text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
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
            } else if (aiEmail && !dedupedEmails.includes(aiEmail) && !isJunkEmail(aiEmail)) {
              dedupedEmails.push(aiEmail);
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes = `AI extraction error: ${message}`;
    }
  }

  // If we got a name but the AI didn't return a personal email, scan the
  // scraped emails for one that matches the name's local-part patterns.
  if (!personalEmail && firstName && lastName) {
    const genericEmail = (input.generic_email || "").toLowerCase().trim();
    const matched = dedupedEmails.find(
      (e) =>
        e !== genericEmail &&
        !isJunkEmail(e) &&
        isPersonalEmail(e) &&
        emailMatchesName(e, firstName!, lastName!),
    );
    if (matched) personalEmail = matched;
  }

  // Build the "other emails" pool: everything we found that isn't the
  // matched personal email or the lead's pre-existing generic email.
  const otherEmails = dedupedEmails.filter(
    (e) =>
      e !== personalEmail &&
      e !== (input.generic_email || "").toLowerCase().trim() &&
      !isJunkEmail(e),
  );

  return {
    first_name: firstName,
    last_name: lastName,
    title,
    personal_email: personalEmail,
    other_emails: otherEmails,
    enrichment_source: firstName ? "website" : null,
    enrichment_notes: notes,
    status: "complete",
    cost_usd: cost,
  };
}
