import type { EnrichmentPhase } from "@/types/app";
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
