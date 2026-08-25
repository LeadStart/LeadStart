// Live enrichment/sourcing pricing, pulled fresh from each Apify actor's current
// pay-per-event pricing (so the UI estimate never goes stale when Apify changes
// list prices). Falls back to the static pricing.ts constants per-field when an
// actor's price can't be read. site_scrape is compute-billed (no per-item list
// price) so it uses a measured constant; pattern_mv is Million Verifier (not
// Apify) and stays credit-based in the caller.
//
// Verified event shapes 2026-08-25:
//   harvestapi~linkedin-profile-search: search-page $0.10/page(25), full-profile
//     $0.004, full-profile-with-email $0.01  → short/full/full_email
//   harvestapi~linkedin-profile-scraper: profile_with_email $0.01
//   harvestapi~linkedin-company:        apify-default-dataset-item (tiered ~$0.004)
//   harvestapi~linkedin-profile-posts:  post (tiered ~$0.002)
//   bovi~email-finder-bulk:             email-found (tiered ~$0.0049)

import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  ACTIVITY_COST_USD,
  BOVI_COST_USD,
  SITE_SCRAPE_COST_USD,
} from "./pricing";

const SOURCING_ACTOR = "harvestapi~linkedin-profile-search";
const PROFILE_ACTOR = "harvestapi~linkedin-profile-scraper";
const DOMAIN_ACTOR = "harvestapi~linkedin-company";
const ACTIVITY_ACTOR = "harvestapi~linkedin-profile-posts";
const BOVI_ACTOR = "bovi~email-finder-bulk";

// LinkedIn search pages return 25 results; the actor bills one search-page event
// per page, so per-profile = page price / 25.
const RESULTS_PER_PAGE = 25;
// site_scrape bills raw Apify compute (no per-item list price). Measured across
// real runs 2026-08-25: ~$0.0015–0.0029/domain. Use a slightly-conservative mid.
const SITE_SCRAPE_MEASURED_USD = 0.003;

export interface LivePricing {
  source: "live" | "partial" | "fallback";
  fetchedAt: string;
  tier: string;
  sourcing: { short: number; full: number; full_email: number };
  enrich: { profile: number; domain: number; activity: number; bovi: number; site_scrape: number };
  notes: string[];
}

type ChargeEvent = {
  eventPriceUsd?: number;
  eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd?: number }>;
};
type Events = Record<string, ChargeEvent>;

function priceOf(events: Events | null, key: string, tier: string): number | null {
  const ev = events?.[key];
  if (!ev) return null;
  if (typeof ev.eventPriceUsd === "number") return ev.eventPriceUsd;
  const tiered = ev.eventTieredPricingUsd;
  const t = tiered?.[tier]?.tieredEventPriceUsd ?? tiered?.FREE?.tieredEventPriceUsd;
  return typeof t === "number" ? t : null;
}

async function currentEvents(token: string, actorId: string): Promise<Events | null> {
  try {
    const res = await fetch(`https://api.apify.com/v2/acts/${actorId}?token=${token}`);
    if (!res.ok) return null;
    const data = (await res.json())?.data;
    const infos = data?.pricingInfos;
    const cur = Array.isArray(infos) && infos.length ? infos[infos.length - 1] : null;
    return (cur?.pricingPerEvent?.actorChargeEvents as Events | undefined) ?? null;
  } catch {
    return null;
  }
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// Per-token cache — pricing changes rarely; a short TTL keeps the dialog fresh
// without hitting Apify on every open.
const cache = new Map<string, { at: number; value: LivePricing }>();
const TTL_MS = 60 * 60 * 1000;

export async function fetchLivePricing(token: string, tier = "FREE"): Promise<LivePricing> {
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const [src, prof, dom, act, bovi] = await Promise.all([
    currentEvents(token, SOURCING_ACTOR),
    currentEvents(token, PROFILE_ACTOR),
    currentEvents(token, DOMAIN_ACTOR),
    currentEvents(token, ACTIVITY_ACTOR),
    currentEvents(token, BOVI_ACTOR),
  ]);
  const notes: string[] = [];
  const missing: string[] = [];

  // Sourcing depth rates recomposed from the search actor's events.
  const searchPage = priceOf(src, "search-page", tier);
  const fullProfile = priceOf(src, "full-profile", tier);
  const fullEmail = priceOf(src, "full-profile-with-email", tier);
  const perPage = searchPage != null ? searchPage / RESULTS_PER_PAGE : null;
  const short = perPage ?? 0.004;
  const full = perPage != null && fullProfile != null ? round4(perPage + fullProfile) : 0.008;
  const full_email = perPage != null && fullEmail != null ? round4(perPage + fullEmail) : 0.014;
  if (src == null) missing.push("sourcing");

  // Enrichment per-item.
  const profile = priceOf(prof, "profile_with_email", tier) ?? PROFILE_EMAIL_COST_USD;
  if (prof == null) missing.push("profile");
  const domain = priceOf(dom, "apify-default-dataset-item", tier) ?? DOMAIN_COST_USD;
  if (dom == null) missing.push("domain");
  const postPrice = priceOf(act, "post", tier);
  const activity = postPrice != null ? round4(postPrice * 2.5) : ACTIVITY_COST_USD; // ~2.5 posts/person
  if (act == null) missing.push("activity");
  const boviPrice = priceOf(bovi, "email-found", tier) ?? BOVI_COST_USD;
  if (bovi == null) missing.push("bovi");

  const gotAll = [src, prof, dom, act, bovi].every(Boolean);
  const source: LivePricing["source"] = gotAll ? "live" : missing.length === 5 ? "fallback" : "partial";
  if (missing.length) notes.push(`Using stored fallback for: ${missing.join(", ")}`);
  notes.push("site_scrape is compute-billed (measured avg, not an Apify list price); pattern_mv uses Million Verifier credits");

  const value: LivePricing = {
    source,
    fetchedAt: new Date().toISOString(),
    tier,
    sourcing: { short: round4(short), full, full_email },
    enrich: {
      profile: round4(profile),
      domain: round4(domain),
      activity,
      bovi: round4(boviPrice),
      site_scrape: SITE_SCRAPE_MEASURED_USD || SITE_SCRAPE_COST_USD,
    },
    notes,
  };
  cache.set(token, { at: Date.now(), value });
  return value;
}
