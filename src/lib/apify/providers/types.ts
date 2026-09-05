import type { EnrichmentSettings } from "@/types/app";

// The subset of an enrichment_run_items row a provider needs to build input and
// join results back. The worker passes the real DB rows (which satisfy this).
export interface ProviderItem {
  id: string;
  linkedin_url: string | null;
  profile_id: string | null;
  company_linkedin_url: string | null;
  company_id: string | null;
  company_slug: string | null;
  company_name: string | null;
  first_name: string | null;
  last_name: string | null;
  company_domain: string | null;
  email: string | null; // current email on the item (used to skip already-found)
}

export interface PhaseResult {
  status: "found" | "not_found";
  email?: string | null;
  confidence?: number; // 0-100: the provider's own confidence in `email`
  companyDomain?: string | null; // set by the domains phase (or profile currentPosition)
  companyLinkedinUrl?: string | null; // set by the profiles phase
  extra?: Record<string, unknown>; // merged into enrichment_data.enrichment.*
  raw?: unknown; // trimmed provider record, kept for audit (feeds catch-all adjudication)
}

// One interface for every phase. `parseItems` returns a Map keyed by
// ProviderItem.id; items with no entry are treated as not_found by the worker.
// Email verification is NOT a provider concern: Million Verifier owns it.
export interface PhaseProvider {
  id: string; // 'harvestapi' | 'harvestapi-company' | 'site_scrape' | 'bovi'
  actorId: string; // Apify "username~actor" id
  // `config` is the run's enrichment-settings snapshot (migration 00075). Only
  // the site-scrape provider reads it today (its scrape_max_pages); the others
  // ignore it.
  buildInput(items: ProviderItem[], config?: EnrichmentSettings | null): unknown;
  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult>;
}

// ---- small shared helpers for providers ----

export function lc(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

// Normalized person key: first|last|domain, all lowercased.
export function personKey(
  first: string | null | undefined,
  last: string | null | undefined,
  domain: string | null | undefined,
): string {
  return `${lc(first)}|${lc(last)}|${lc(domain)}`;
}

export function trimRaw(obj: unknown, maxLen = 4000): unknown {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= maxLen) return obj;
    return { _truncated: true, preview: s.slice(0, maxLen) };
  } catch {
    return null;
  }
}
