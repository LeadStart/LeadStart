// Layer 1: website-scrape decision-maker extraction.
//
// Fetch the business homepage, then up to 4 about/team/contact pages at once
// (best first, see findContactPages), strip each to plain text, give every
// page its own share of the prompt's text budget, and ask Claude Haiku for the
// most senior decision maker using the seniority hierarchy for the business's
// category. Falls through with status='complete' and empty fields if no
// decision maker is found: the caller decides whether to escalate to Layer 2.
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
import { fetchPage, htmlToText, findContactPages, PAGE_HTML_MAX_CHARS } from "./fetcher";
import { getSeniorityPriority, getSkipRoles } from "./seniority-maps";
import { calculateCost, HAIKU_MODEL_ID } from "./pricing";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

// Website text in the prompt, in chars (~4 per token, so ~5,000 tokens at
// most). Split PER PAGE so every page read reaches the model: each subpage gets
// an even share (a short page keeps all its text and frees the rest for the
// others), and the homepage, trimmed first, takes what is left but never less
// than HOME_TEXT_FLOOR. Until 2026-10-11 the pages were joined homepage-first
// and cut at 12,000 chars: on 23 of 78 audited sites with about/contact pages,
// none of their text reached the model, so owners named only there were missed.
const PAGE_TEXT_BUDGET = 20_000;
const HOME_TEXT_FLOOR = 3_000;

// Page fetches get the first half of the per-business limit (enrichBusiness
// races the whole lookup against it: 30 s in the naming phase), so the Haiku
// call and, when Layer 1 names nobody, Layer 2's web search keep the rest.
// The subpages load together, so fetching takes the homepage plus the slowest
// subpage, not the sum of all five: one after another they could take 50 s,
// which timed the lookup out and lost every page already read.
const FETCH_SHARE_OF_LIMIT = 0.5;
const PAGE_TIMEOUT_MS = 10_000;
// With less than this left, subpage requests would only be started to be aborted.
const MIN_SUBPAGE_WINDOW_MS = 500;

interface PageText {
  url: string;
  text: string;
}

// Max-min fair split of `budget` across texts of these lengths: any text that
// fits an even share keeps all of it, the longer ones split the rest evenly.
function fairShares(lengths: number[], budget: number): number[] {
  const shares = lengths.map(() => 0);
  const shortestFirst = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  let remaining = budget;
  for (let k = 0; k < shortestFirst.length; k++) {
    const even = Math.floor(remaining / (shortestFirst.length - k));
    const i = shortestFirst[k];
    if (lengths[i] > even) {
      for (const j of shortestFirst.slice(k)) shares[j] = even;
      break;
    }
    shares[i] = lengths[i];
    remaining -= lengths[i];
  }
  return shares;
}

// The {page_text} for the prompt: the homepage, then each subpage in the order
// findContactPages ranked them, each cut to its share and labelled by its path.
function buildPageText(home: PageText, subpages: PageText[]): string {
  const homeFloor = Math.min(home.text.length, HOME_TEXT_FLOOR);
  const shares = fairShares(subpages.map((p) => p.text.length), PAGE_TEXT_BUDGET - homeFloor);
  const homeShare = PAGE_TEXT_BUDGET - shares.reduce((sum, s) => sum + s, 0);
  const sections = [`[Homepage]\n${home.text.substring(0, homeShare)}`];
  subpages.forEach((p, i) => {
    sections.push(`[Page: ${new URL(p.url).pathname}]\n${p.text.substring(0, shares[i])}`);
  });
  return sections.join("\n\n");
}

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

  // No limit given (a direct call): each page just gets PAGE_TIMEOUT_MS.
  const fetchDeadline = Date.now() + (opts.perBusinessTimeoutMs ?? Infinity) * FETCH_SHARE_OF_LIMIT;
  const timeLeft = () => Math.min(PAGE_TIMEOUT_MS, fetchDeadline - Date.now());

  const mainHtml = await fetchPage(website, { maxChars: PAGE_HTML_MAX_CHARS, timeoutMs: timeLeft() });
  if (!mainHtml) return emptyResult("Could not reach website");

  const home: PageText = { url: website, text: htmlToText(mainHtml) };
  const subpages: PageText[] = [];
  const allEmails: string[] = [...extractEmails(mainHtml)];

  // All subpages at once (at most 4 requests to the site), each cut off when the
  // fetch window closes; results stay in findContactPages' rank order.
  const contactPages = findContactPages(mainHtml, website).filter(isSafeUrl);
  const subpageWindowMs = timeLeft();
  const pageHtmls =
    subpageWindowMs >= MIN_SUBPAGE_WINDOW_MS
      ? await Promise.all(
          contactPages.map((pageUrl) => fetchPage(pageUrl, { maxChars: PAGE_HTML_MAX_CHARS, timeoutMs: subpageWindowMs })),
        )
      : [];
  pageHtmls.forEach((pageHtml, i) => {
    if (!pageHtml) return;
    try {
      subpages.push({ url: contactPages[i], text: htmlToText(pageHtml) });
      allEmails.push(...extractEmails(pageHtml));
    } catch {
      // One bad subpage shouldn't kill enrichment.
    }
  });

  const pagesScraped = 1 + subpages.length;
  const textChars = subpages.reduce((sum, p) => sum + p.text.length, home.text.length);
  const dedupedEmails = [...new Set(allEmails)];

  let firstName: string | null = null;
  let lastName: string | null = null;
  let title: string | null = null;
  let personalEmail: string | null = null;
  let cost = 0;
  let notes = `Scraped ${pagesScraped} page${pagesScraped === 1 ? "" : "s"}, found ${dedupedEmails.length} email${dedupedEmails.length === 1 ? "" : "s"}`;

  if (textChars > 50) {
    try {
      const anthropic = new Anthropic({ apiKey: opts.anthropicKey });
      const prompt = DEFAULT_LAYER1_PROMPT
        .replace(/\{business_name\}/g, input.business_name)
        .replace(/\{website\}/g, input.website || "unknown")
        .replace(/\{city\}/g, (input.city || "").trim())
        .replace(/\{state\}/g, (input.state || "").trim())
        .replace(/\{category\}/g, (input.category || "General").trim())
        .replace(/\{seniority_priority\}/g, getSeniorityPriority(input.category || "", opts.serviceType))
        .replace(/\{skip_roles\}/g, getSkipRoles(input.category || "", opts.serviceType))
        // Last, and through a function: page text is arbitrary web content, so
        // a "$&" or a "{city}" in it must reach the model as written.
        .replace(/\{page_text\}/g, () => buildPageText(home, subpages));

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
