import type { EnrichmentPhase, EnrichmentSettings } from "@/types/app";
import type { PhaseProvider } from "./types";
import { profileProvider, PROFILE_ACTOR_ID } from "./profile-harvestapi";
import { companyProvider, DOMAIN_ACTOR_ID } from "./company-harvestapi";
import { waterfallVdrmotaProvider, WATERFALL_VDRMOTA_ACTOR_ID } from "./waterfall-vdrmota";
import { waterfallBoviProvider, WATERFALL_BOVI_ACTOR_ID } from "./waterfall-bovi";
import { activityProvider, ACTIVITY_ACTOR_ID } from "./activity-harvestapi";

// Actor snapshots written onto enrichment_runs at start time. The owner's Apify
// account is on a paid tier (2026-08-22), so the waterfall defaults to the
// official vdrmota contact scraper; bovi stays registered as the Free-tier
// fallback (swap this one constant to WATERFALL_BOVI_ACTOR_ID).
// Email verification is NOT an Apify phase — Million Verifier owns it.
export const PROFILE_ACTOR = PROFILE_ACTOR_ID;
export const DOMAIN_ACTOR = DOMAIN_ACTOR_ID;
export const WATERFALL_ACTOR = WATERFALL_VDRMOTA_ACTOR_ID;
export const ACTIVITY_ACTOR = ACTIVITY_ACTOR_ID;

export {
  PROFILE_ACTOR_ID,
  DOMAIN_ACTOR_ID,
  WATERFALL_VDRMOTA_ACTOR_ID,
  WATERFALL_BOVI_ACTOR_ID,
  ACTIVITY_ACTOR_ID,
};

const WATERFALL_BY_ACTOR: Record<string, PhaseProvider> = {
  [WATERFALL_VDRMOTA_ACTOR_ID]: waterfallVdrmotaProvider,
  [WATERFALL_BOVI_ACTOR_ID]: waterfallBoviProvider,
};

// Resolve the Apify waterfall actor from an org's enrichment settings (migration
// 00075). Phase 1 runs a SINGLE actor for the whole waterfall — true per-item,
// per-size-band routing lands in Phase 2 (advancePhase stamps waterfall_method).
// Until then we pick the first Apify method across the bands (unknown first,
// since Phase 1 computes no size), so the all-vdrmota defaults resolve to
// vdrmota and current behavior is preserved. Returns null when no band names an
// Apify method (all off / direct-only) → the waterfall is skipped for the run.
export function resolveWaterfallActor(settings: EnrichmentSettings): string | null {
  for (const m of [settings.unknown_method, settings.small_method, settings.large_method]) {
    if (m === "vdrmota") return WATERFALL_VDRMOTA_ACTOR_ID;
    if (m === "bovi") return WATERFALL_BOVI_ACTOR_ID;
  }
  return null;
}

// Resolve the provider for a phase. `actorId` is the run's snapshot (only the
// waterfall has a choice); the others are fixed per phase.
export function getProvider(phase: EnrichmentPhase, actorId: string | null): PhaseProvider | null {
  switch (phase) {
    case "profiles":
      return profileProvider;
    case "domains":
      return companyProvider;
    case "waterfall":
      return (actorId && WATERFALL_BY_ACTOR[actorId]) || waterfallVdrmotaProvider;
    case "activity":
      return activityProvider;
    default:
      return null;
  }
}

export {
  profileProvider,
  companyProvider,
  waterfallVdrmotaProvider,
  waterfallBoviProvider,
  activityProvider,
};
