import type { EnrichmentSettings, EnrichmentWaterfallMethod } from "@/types/app";

// Shared waterfall-routing rules: the single source of truth for BOTH the cron
// worker's seedWaterfallItems (domains→waterfall transition) and the manual
// Contacts → Enrich route's seed-at-insert case (when waterfall is the only
// phase). Kept in one place so the two seeding sites can't drift.

// A contact "has a usable name" when either name part is ≥2 real chars: the
// minimum pattern_mv needs to build local-part guesses (first.last@, flast@, …).
// A name-less lead (a Google-Maps business with no decision-maker resolved yet)
// can only be worked by scraping its site.
export function hasUsableName(first: string | null, last: string | null): boolean {
  return (first?.trim().length ?? 0) >= 2 || (last?.trim().length ?? 0) >= 2;
}

// Route an item to its size-band method from the run's config snapshot. Name-less
// items are forced onto site_scrape: pattern_mv / bovi generate or look up an
// email FROM a name (impossible without one), and scrape_plus_pattern's pattern
// stage would too, so all three collapse to a pure site scrape.
//
// opts.companyInbox (the item's contact opted into the company-inbox fallback):
// a named item whose band only guesses (pattern_mv) gets the site scrape first
// (scrape_plus_pattern), so a generic inbox is captured for the fallback to use;
// the scrape's misses still go on to pattern_mv. bovi and off bands are left as
// configured. The org's settings are not changed.
export function methodForItem(
  config: EnrichmentSettings,
  employeeCount: number | null,
  hasName: boolean,
  opts: { companyInbox?: boolean } = {},
): EnrichmentWaterfallMethod {
  const band =
    employeeCount == null
      ? config.unknown_method
      : employeeCount >= config.size_threshold
        ? config.large_method
        : config.small_method;
  if (!hasName && (band === "pattern_mv" || band === "bovi" || band === "scrape_plus_pattern")) {
    return "site_scrape";
  }
  if (opts.companyInbox && band === "pattern_mv") return "scrape_plus_pattern";
  return band;
}
