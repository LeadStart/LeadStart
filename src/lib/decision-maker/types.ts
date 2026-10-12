import type { ServiceType } from "./seniority-maps";

export type { ServiceType };

// Flat input fed to the enrichment pipeline. Built from a row of
// prospect_searches.results plus a runtime profile selection. No Drizzle
// types: the original LeadEnrich tool's Lead/Job shapes are gone.
export interface EnrichmentInput {
  business_name: string;
  website: string | null;
  category: string | null;
  city: string | null;
  state: string | null;
  generic_email: string | null;
}

export interface EnrichmentOptions {
  serviceType: ServiceType;
  useLayer2: boolean;
  // Both layers run on it: Layer 1 reads the site with Haiku 4.5, Layer 2 web
  // searches with Haiku 5.5 (the org's Anthropic account needs web search on).
  anthropicKey: string;
  // Per-business hard timeout to keep one slow site from starving a tick.
  // Default 60s, mirroring server/enricher.ts:484 in the original. Layer 1
  // spends at most the first half of it fetching pages.
  perBusinessTimeoutMs?: number;
}

export interface EnrichmentResult {
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  personal_email: string | null;
  other_emails: string[];
  enrichment_source: "website" | "web_search" | null;
  enrichment_notes: string;
  status: "complete" | "error" | "skipped";
  cost_usd: number;
}
