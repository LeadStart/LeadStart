// Decision-maker enrichment orchestrator.
//
// Run Layer 1 (website scrape). If it returned no decision maker AND the
// run opted into Layer 2, fall through to Layer 2 (web search) and merge
// the result. Per-business hard timeout via Promise.race so one slow site
// can't starve the worker tick.

import { enrichWithWebsite } from "./layer1";
import { enrichWithWebSearch } from "./layer2";
import type { EnrichmentInput, EnrichmentOptions, EnrichmentResult } from "./types";

export type {
  EnrichmentInput,
  EnrichmentOptions,
  EnrichmentResult,
  ServiceType,
} from "./types";

const DEFAULT_PER_BUSINESS_TIMEOUT_MS = 60_000;

function timeoutPromise<T>(ms: number, label: string): Promise<T> {
  return new Promise<T>((_, reject) => {
    setTimeout(() => reject(new Error(`${label} (${ms / 1000}s)`)), ms);
  });
}

function mergeResults(layer1: EnrichmentResult, layer2: EnrichmentResult): EnrichmentResult {
  // Layer 2 only "wins" if it actually produced a name. If both layers
  // came back empty we keep Layer 1's notes for context (they explain why
  // it was empty — no website, unreachable, AI miss, etc.).
  const layer2Found = Boolean(layer2.first_name);

  const mergedNotes = [layer1.enrichment_notes, layer2.enrichment_notes]
    .filter(Boolean)
    .join(" | ");

  const mergedOtherEmails = [...new Set([...layer1.other_emails, ...layer2.other_emails])];

  if (layer2Found) {
    return {
      first_name: layer2.first_name,
      last_name: layer2.last_name,
      title: layer2.title,
      personal_email: layer2.personal_email,
      other_emails: mergedOtherEmails,
      enrichment_source: layer2.enrichment_source,
      enrichment_notes: mergedNotes,
      // If layer 2 errored mid-call but somehow returned a name, preserve
      // the error status; otherwise complete.
      status: layer2.status === "error" ? "error" : "complete",
      cost_usd: layer1.cost_usd + layer2.cost_usd,
    };
  }

  return {
    first_name: layer1.first_name,
    last_name: layer1.last_name,
    title: layer1.title,
    personal_email: layer1.personal_email,
    other_emails: mergedOtherEmails,
    enrichment_source: layer1.enrichment_source,
    enrichment_notes: mergedNotes,
    status: layer2.status === "error" ? "error" : layer1.status,
    cost_usd: layer1.cost_usd + layer2.cost_usd,
  };
}

export async function enrichBusiness(
  input: EnrichmentInput,
  opts: EnrichmentOptions,
): Promise<EnrichmentResult> {
  const timeoutMs = opts.perBusinessTimeoutMs ?? DEFAULT_PER_BUSINESS_TIMEOUT_MS;

  const work = async (): Promise<EnrichmentResult> => {
    const layer1 = await enrichWithWebsite(input, opts);

    if (!opts.useLayer2 || layer1.first_name) {
      return layer1;
    }

    const layer2 = await enrichWithWebSearch(input, opts);
    return mergeResults(layer1, layer2);
  };

  try {
    return await Promise.race([
      work(),
      timeoutPromise<EnrichmentResult>(timeoutMs, "Lead processing timeout"),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      first_name: null,
      last_name: null,
      title: null,
      personal_email: null,
      other_emails: [],
      enrichment_source: null,
      enrichment_notes: message,
      status: "error",
      cost_usd: 0,
    };
  }
}
