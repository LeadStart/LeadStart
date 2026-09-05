import type { EnrichmentPhase, EnrichmentSettings } from "@/types/app";
import type { PhaseProvider } from "./types";
import { profileProvider, PROFILE_ACTOR_ID } from "./profile-harvestapi";
import { companyProvider, DOMAIN_ACTOR_ID } from "./company-harvestapi";
import { waterfallBoviProvider, WATERFALL_BOVI_ACTOR_ID } from "./waterfall-bovi";
import { waterfallScrapeProvider, WATERFALL_SCRAPE_ACTOR_ID } from "./waterfall-scrape";
import { activityProvider, ACTIVITY_ACTOR_ID } from "./activity-harvestapi";

// Actor snapshots written onto enrichment_runs at start time. Email verification
// is NOT an Apify phase: Million Verifier owns it.
//
// Since migration 00075 the waterfall METHOD is org-configurable and defaults to
// pattern_mv (a direct method, no Apify actor): see DEFAULT_ENRICHMENT_SETTINGS.
// The run's waterfall actor is resolved per method by resolveWaterfallActor + the
// worker's per-method routing.
export const PROFILE_ACTOR = PROFILE_ACTOR_ID;
export const DOMAIN_ACTOR = DOMAIN_ACTOR_ID;
export const ACTIVITY_ACTOR = ACTIVITY_ACTOR_ID;

export {
  PROFILE_ACTOR_ID,
  DOMAIN_ACTOR_ID,
  WATERFALL_BOVI_ACTOR_ID,
  WATERFALL_SCRAPE_ACTOR_ID,
  ACTIVITY_ACTOR_ID,
};

const WATERFALL_BY_ACTOR: Record<string, PhaseProvider> = {
  [WATERFALL_BOVI_ACTOR_ID]: waterfallBoviProvider,
  [WATERFALL_SCRAPE_ACTOR_ID]: waterfallScrapeProvider,
};

// Resolve a representative Apify waterfall actor from an org's settings for the
// run's `waterfall_actor` snapshot. Real per-item routing lives in the worker
// (advancePhase stamps waterfall_method; startNextWaterfall picks the actor per
// method group), so this is just a sensible default for the run row. Returns
// null when no band names an Apify method (all pattern_mv / off): the worker
// still routes those (direct pattern_mv, or the scrape actor per method).
export function resolveWaterfallActor(settings: EnrichmentSettings): string | null {
  for (const m of [settings.unknown_method, settings.small_method, settings.large_method]) {
    if (m === "bovi") return WATERFALL_BOVI_ACTOR_ID;
    if (m === "site_scrape" || m === "scrape_plus_pattern") return WATERFALL_SCRAPE_ACTOR_ID;
  }
  return null;
}

// Resolve the provider for a phase. `actorId` is the run's snapshot (only the
// waterfall has a choice). The waterfall fallback is a non-null placeholder so
// the worker proceeds to its per-method router (the default pattern_mv path uses
// no provider); it's never actually invoked for parsing in that case.
export function getProvider(phase: EnrichmentPhase, actorId: string | null): PhaseProvider | null {
  switch (phase) {
    case "profiles":
      return profileProvider;
    case "domains":
      return companyProvider;
    case "waterfall":
      return (actorId && WATERFALL_BY_ACTOR[actorId]) || waterfallScrapeProvider;
    case "activity":
      return activityProvider;
    default:
      return null;
  }
}

export {
  profileProvider,
  companyProvider,
  waterfallBoviProvider,
  waterfallScrapeProvider,
  activityProvider,
};
