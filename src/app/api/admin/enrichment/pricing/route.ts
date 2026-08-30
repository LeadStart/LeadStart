import { NextResponse } from "next/server";
import { requireEnrichmentContext } from "@/lib/apify/auth";
import { fetchLivePricing, type LivePricing } from "@/lib/apify/live-pricing";
import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  ACTIVITY_COST_USD,
  BOVI_COST_USD,
  SITE_SCRAPE_COST_USD,
  DOMAIN_DISCOVERY_COST_USD,
  NAMING_COST_USD,
  MAPS_PLACE_COST_USD,
  MAPS_FILTER_COST_USD,
  SOURCING_SHORT_USD,
  SOURCING_FULL_USD,
  SOURCING_FULL_EMAIL_USD,
} from "@/lib/apify/pricing";

// GET /api/admin/enrichment/pricing
//
// Live per-actor pricing for the cost estimates, pulled fresh from Apify (cached
// ~1h). Returns the static pricing.ts constants as a fallback when no Apify token
// is set or a fetch fails, so the UI always has usable numbers.

export const dynamic = "force-dynamic";

function staticFallback(): LivePricing {
  return {
    source: "fallback",
    fetchedAt: new Date().toISOString(),
    // These constants are calibrated to our BRONZE/Starter tier (SPEND-28).
    tier: "BRONZE",
    sourcing: { short: SOURCING_SHORT_USD, full: SOURCING_FULL_USD, full_email: SOURCING_FULL_EMAIL_USD },
    maps: { place: MAPS_PLACE_COST_USD, filter: MAPS_FILTER_COST_USD },
    enrich: {
      profile: PROFILE_EMAIL_COST_USD,
      domain: DOMAIN_COST_USD,
      activity: ACTIVITY_COST_USD,
      bovi: BOVI_COST_USD,
      site_scrape: SITE_SCRAPE_COST_USD,
      domain_discovery: DOMAIN_DISCOVERY_COST_USD,
      naming: NAMING_COST_USD,
    },
    notes: ["No Apify token set — showing stored fallback prices"],
  };
}

export async function GET() {
  const ctx = await requireEnrichmentContext();
  if ("error" in ctx) return ctx.error;
  const { apifyToken } = ctx;

  if (!apifyToken) {
    return NextResponse.json(staticFallback());
  }
  try {
    // Our account is on the Starter (BRONZE) tier, so price at that tier, not FREE.
    const pricing = await fetchLivePricing(apifyToken, "BRONZE");
    return NextResponse.json(pricing);
  } catch (err) {
    console.error("[enrichment/pricing] live fetch failed:", err);
    return NextResponse.json(staticFallback());
  }
}
