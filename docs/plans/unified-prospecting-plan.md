# Unified prospecting: synthesis plan (cost-ordered pipeline)

> Companion to [`docs/PROSPECTING_FLOW.md`](../PROSPECTING_FLOW.md) (the as-built,
> code-verified truth). This doc is the FORWARD plan for merging the two veins into
> one entry point with one merged lead pool. Prices cited here were verified from
> the Apify API on 2026-08-28; hit-rates come from the 2026-08-28 King County
> bake-off (small samples, marked as such).

## Design principle

Spend in ascending order of cost. Each cheap stage prunes the pool the next,
pricier stage runs on. Expensive person-resolution never sees a lead a cheap
check could have disqualified.

## Pipeline

0. **Canonical query** - location (geo_places picker), business type, ICP
   (size/roles), add-ons. One entry point.
1. **Router** - each dimension runs where it is NATIVE (free): geo + business
   type on Maps; size/role/industry on LinkedIn (harvestapi filters headcount and
   title at search time). Primary vein per query; the other vein is a targeted
   supplement, never a blanket duplicate.
2. **Source cheap** - Maps $0.004/place; LinkedIn short mode $0.004/person
   (never full+email at source time; enrichment does emails on kept leads only).
3. **Dedup (free)** - merge on linkedin_url, then google_place_id, then
   company_domain, BEFORE any enrichment spend. Nothing is enriched twice.
4. **Cheap enrichment floor** - site_scrape generic info@ + phone (~$0.003 per site (compute), not per lead);
   **catch-all pre-gate**: one MV probe per domain (~$0.004 normal, free verdict
   on catch-all) - catch-all domains never enter the personal-email machinery.
5. **Person-resolution, gated + cost-ordered.** Gate = has domain AND not
   catch-all AND quality bar (claimed, >=10 reviews, >=4.0 stars, in-ICP; ~57%
   of the WA sample) :
   1. compass business-leads: $0.0075 **billed per HIT only** (miss = $0), but
      the `maximumLeadsEnrichmentRecords` cap is **PER PLACE, not per run** (we
      always send ≤3); uncapped it dumps whole chain rosters (the 2026-08-30
      $14.17 incident was an uncapped 400/place). Full semantics:
      [`docs/APIFY_ACTOR_COSTS.md`](../APIFY_ACTOR_COSTS.md).
      ~33% hit (n=15). Hit delivers name + title + LinkedIn URL + often email.
   2. Live profile scrape on ANY LinkedIn URL: $0.01 incl. email search (the
      profiles phase already does this by URL). Includes the **entity-authority
      guard** (owner ruling 2026-08-28): the person's own LOCATION is IRRELEVANT
      - a decision-maker anywhere is valid as long as what they oversee is the
      target-area business. Distrust ONLY on ENTITY mismatch: their current
      company is the franchisor/brand or a different company rather than this
      business or its owning entity (the Stratus case: national-brand CEO
      returned for a local franchise location).
   3. Naming only on the misses: ~$0.015 Perplexity Sonar. Layer 2 is now
      Perplexity-ONLY (Claude web_search fallback removed 2026-08-28), so a
      Perplexity key is REQUIRED for owner-name discovery to run at all. 50-67%
      hit (two small samples).
   4. pattern_mv + MV on the named: ~$0.01-0.02 (catch-alls pre-screened, so no
      doomed guessing).
   5. Agreement bonus: two independent sources returning the same person = high
      confidence, stop spending on that lead.
6. **MV verify everything with an email -> delivered-outcome ledger** (the
   $0.05 / $0.10 / $0.20 / $0.30 tiers).

## Cost model per 1,000 Maps-sourced SMBs (Perplexity key present)

Measured = ✓, assumption = ~.

| Stage | Pool | Cost |
|---|---|---|
| Source ✓ | 1,000 | $4.00 |
| site_scrape ✓ (83% domains ✓) | 830 | $2.49 |
| Catch-all probe (~30% catch-all ~) | 830 | ~$2.30 |
| Quality gate (57% ✓) | -> ~350 | $0 |
| compass leads per-hit (33% ✓) | ~115 hits | $0.86 |
| Live URL scrape + email | 115 | $1.15 |
| Perplexity naming on misses | 235 | ~$3.50 |
| pattern_mv + verify | ~130 | ~$2.50 |
| **Total** | | **~$17-18** |

Yield: ~1,000 records w/ phone, ~550 generic emails, ~250 named owners,
~120-180 verified personal emails. Blended ~$0.017/lead; ~$0.10-0.15 per
verified personal email vs the $0.30 tier. Naive blanket Claude naming on the
same 1,000: ~$65-70. The gates, not cheaper steps, are the ~4x.

## Per-vein cost per VERIFIED PERSONAL email (the ordering rule)

LinkedIn vein: source $0.004 + profile-scrape-with-email $0.01 + MV verify ->
~$16/1,000 people; at a 40-60% email-found rate (UNMEASURED assumption) and ~75%
verify-ok, that is **~$0.035-0.055 per verified personal email**. Maps vein
personal path: **~$0.10-0.15** (it pays a discovery tax LinkedIn skips: naming
the owner + blind pattern guessing, amortized over funnel attrition).

**Rule: LinkedIn-first for personal emails.** The Maps personal path is the
COVERAGE premium for owners no ICP search can find (the bake-off's invisible
tail: naming found 8/15 owners vs the LinkedIn-derived DB's 5/15). So for a
unified query: run the LinkedIn ICP pass first, dedup by domain/company, and
send a Maps business into naming ONLY if its owner did not surface in the
LinkedIn pass. The LinkedIn pass is one more pre-gate; blended personal-email
cost lands ~$0.05-0.08. Calibration needed: the actual email-found rate of
`linkedin-profile-scraper` on our SMB targets (also confirm whether the $0.01
profile_with_email event bills per profile processed or only per email found).

## The saturation thesis (why the expensive tier may be the best ROI)

Acquisition cost correlates INVERSELY with inbox saturation:
- Tier 1 LinkedIn-easy ($0.03-0.05): in every database (Apollo/ZoomInfo/etc) ->
  hammered inboxes. Cheap because everyone has them.
- Tier 2 generic info@ ($0.003-0.007): pullable by any Maps-scraper user ->
  moderately saturated, but SMB owners read it themselves.
- Tier 3 discovered personal ($0.10-0.15): exists in NO database - the discovery
  work (Maps -> naming -> pattern -> verify) is the moat. Near-virgin inboxes.

Right metric = cost per POSITIVE REPLY, not per lead: $0.05 at ~1% positive =
$5/positive; $0.15 needs only ~3% to match, and unsaturated lists routinely
beat that spread. Also: less spam fatigue -> fewer flags -> healthier domains.
Counterweights: part of the tail is barely digital, wrong-person risk (guards
required), and a hard volume ceiling per geo/vertical.

**Measurable in-system:** leads carry acquisition provenance (ledger tiers) and
the reply pipeline classifies sentiment -> build "reply rate by acquisition
tier" reporting and let real sends confirm or kill the thesis. This turns the
outcome ledger into a per-tier ROI instrument, not just billing substrate.

## Efficiency mechanisms

1. Cost-ordered gating (each stage prunes the next).
2. Per-hit sources before per-attempt sources (compass is free on miss, but its
   `maximumLeadsEnrichmentRecords` cap is PER PLACE, always send ≤3).
3. Catch-all pre-gate before naming (kills doomed personal-email spend).
4. URL-first resolution ($0.01 live scrape beats ~$0.025 naming+pattern, fresher).
5. Franchise/mismatch guard ($0.01 turns confidently-wrong into a caught flag).
6. Router native-ness (filters run where they are free).
7. Dedup at every boundary (linkedin_url / google_place_id / company_domain).
8. Perplexity key = the ~4-5x naming lever (wired 2026-08-28; Layer 2 is
   Perplexity-only, so no key = naming no-ops).

## Build plan (Claude-session estimates)

- **A. Cross-feed (~1 session):** compass business-leads as an opt-in Maps
  add-on -> write linkedin_url onto the contact -> existing profiles phase picks
  it up -> franchise guard on mismatch. ⚠️ Wire `maximumLeadsEnrichmentRecords`
  as a cap PER PLACE (always ≤3), never per run: the 2026-08-30 $14.17 incident
  was an uncapped 400/place. See [`docs/APIFY_ACTOR_COSTS.md`](../APIFY_ACTOR_COSTS.md).
- **B. Gates (~1 session):** catch-all pre-gate before naming in
  run-apify-enrichment + the quality bar as config (automatic selectivity).
- **B2. Naming accuracy hardening (~1 session, prompt audit 2026-08-28):**
  Layer 2 already says "LOCAL owner/operator, not corporate HQ" (prompts.ts:42)
  and correctly leaves the PERSON's location unconstrained, and it failed safe on
  Stratus (returned nothing, not the corporate CEO). But it is instruction, not
  guarantee: add (a) an explicit "brand-level execs of a multi-location brand =
  return not found" rule; (b) a `scope` output field (local_operator / corporate
  / unknown) so downstream can gate; (c) a validation-side entity check (title/
  company in the result naming a DIFFERENT entity than the business -> flag
  risky, do not hard-reject); (d) a wrong-person audit column in the calibration
  run (validation today is anti-hallucination only - validation.ts checks name
  plausibility, never authority).
- **B3. Business-name normalization (~1 session, audit 2026-08-28):** Google
  Business Profile names are keyword-stuffed by owners for local SEO (same root
  cause as the Scrap.io-era bizarre names); today import-maps-places writes the
  raw title into contacts.company_name (import-maps-places.ts:84). Audit of the
  250-lead WA run: ~10-12% mangled (pipe-stuffed, geo tails, ALL CAPS,
  domain-as-name, 17 over 40 chars) + 47 legal suffixes. Fix: a pure
  deterministic normalizer at import (split on pipes, drop parenthetical legal
  aliases, strip LLC/Inc suffixes, strip geo tails using the lead's own
  city/state + the geo_places gazetteer as the dictionary, title-case ALL-CAPS,
  de-.com), raw preserved in enrichment_data.source_row (no migration);
  ambiguous cases FLAGGED, with an optional Haiku pass on flagged residue only
  (~$0.0002/name). Payoff: clean {{company}} tokens in sends, sharper
  naming-phase search queries, better fuzzy entity matching for Phase D dedup.
- **C. Unified entry point (1-2 sessions):** canonical query object + router +
  one merged pool over both veins (D+cart picker is the front-end base).
- **D. Identity hardening (~1 session):** fuzzy merge (name+domain+geo) for
  URL-less leads.

**Owner levers:** Perplexity key in Settings -> Integrations (biggest lever,
before any scaled naming); a $ cap for a ~100-lead calibration run to tighten
the ~30% catch-all and 33% compass-hit assumptions; push approvals per phase.

**Known-unknowns to calibrate:** compass hit-rate by vertical (n=15), catch-all
rate (unmeasured), pattern_mv verified-ok rate post-gate, LinkedIn-vein overlap
rate for SMB queries.
