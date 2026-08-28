# Prospecting flow — both veins (CANONICAL, code-verified)

> **This is the source of truth for how the two prospecting veins work end to end.**
> Read it before answering any question about the flow. Update it **in the same
> change** as any edit to sourcing, enrichment, or the actors. Every claim cites
> `file:line` so it is verifiable, not remembered. Prices were read from the Apify
> API (pay-per-event configs) on 2026-08-28; re-verify if quoting them as current.
>
> Why this exists: flow claims were made from partial reads and got the LinkedIn
> pipeline wrong. The rule now: trace the code (and this doc), don't reason from memory.

---

## 1. The two veins at a glance

| | **Maps vein** | **LinkedIn vein** |
|---|---|---|
| Entry | business-first (geo + business type) | people-first (ICP: title/industry/size/location) |
| Sourcing actor | `compass/google-maps-extractor` | `harvestapi/linkedin-profile-search` |
| A sourced row is | a business (name-less, has domain/phone, **no email**) | a person (name + `linkedin_url`, company, sometimes email) |
| Lands in | `contacts` | `contacts` |
| Enrichment | **the same shared engine** (`run-apify-enrichment`) | **the same shared engine** |

**Key fact: there is ONE enrichment engine for both veins.** The veins differ only
in *sourcing*; both feed `contacts`, and `run-apify-enrichment` auto-routes each
lead through the same phase state machine based on the lead's data (has-`linkedin_url`
vs name-less-business). This IS the "veins meet at enrichment" design, already built.

---

## 2. Sourcing

### 2a. Maps sourcing
- Actor `compass~google-maps-extractor` ([`maps-search.ts:19`](../src/lib/apify/sourcing/maps-search.ts)). Scrapes public Google Maps (not the official API).
- Returns: place_id, name, categories, website, phone, address parts, lat/lng, rating, review count, claimed, open/closed. **No email** ([`maps-search.ts:11-18`](../src/lib/apify/sourcing/maps-search.ts)).
- We deliberately keep the actor's OWN add-ons OFF (`scrapeContacts:false`, `maximumLeadsEnrichmentRecords:0`, `scrapePlaceDetailPage:false`) — we enrich ourselves, cheaper ([`maps-search.ts:65-77`](../src/lib/apify/sourcing/maps-search.ts)).
- Flow: `maps-search` route → `maps_searches` row → `run-maps-searches` cron (multi-area fan-out, one actor run per structured area, merge/dedupe by `google_place_id`) → `importMapsPlaces` → `contacts` with `company_domain`, `company_phone`, `google_place_id`, **`email:null`** ([`import-maps-places.ts:73-105`](../src/lib/apify/import-maps-places.ts)).
- **Cost:** ~$0.004/place on our tier (~$4/1k; Free $0.005 → Business $0.0021, verified). Optional add-on events (we keep off): company-contacts $0.003/place, business-leads $0.0075/found-lead, email-verify $0.004/decisive.

### 2b. LinkedIn sourcing
- Actor `harvestapi~linkedin-profile-search` ([`profile-search.ts:12`](../src/lib/apify/sourcing/profile-search.ts)). Live, **cookieless** LinkedIn scraping; searches by ICP filters (titles, locations, companies, headcount, industry, seniority) ([`profile-search.ts:28-47`](../src/lib/apify/sourcing/profile-search.ts)).
- Depth dial `profileScraperMode` ([`profile-search.ts:14-18`](../src/lib/apify/sourcing/profile-search.ts)): Short (search page only) / Full (opens each profile) / Full+email.
- Returns: `linkedin_url`, name, headline, location, current company, `company_domain`, email (full+email mode) ([`profile-search.ts:145-175`](../src/lib/apify/sourcing/profile-search.ts)).
- Flow: `linkedin-search` route → `linkedin_searches` row → `run-linkedin-searches` cron → `linkedin-save` → `contacts` (deduped by `lower(linkedin_url)`/`lower(email)`) → **auto-enqueues enrichment** ([`linkedin-save/route.ts:93-99`](../src/app/api/admin/prospecting/linkedin-save/route.ts)).
- **Cost (verified):** search-page $0.10/25 results; full-profile $0.004; full+email $0.01.

---

## 3. The shared enrichment engine (`run-apify-enrichment`)

One state machine for BOTH veins. Phase order, `advancePhase` ([`route.ts:2379-2475`](../src/app/api/cron/run-apify-enrichment/route.ts)):

```
profiles → domains → naming → waterfall → activity → verify → complete
```

Each phase is gated by a per-run flag (`run_*`) AND by whether any items qualify;
if none qualify it falls straight through to the next phase. `run_profiles` and
`run_domains` are always true; the rest come from settings/add-ons
([`enqueue-enrichment.ts:210-215`](../src/lib/apify/enqueue-enrichment.ts)).
A run always starts at `phase:"profiles"` ([`enqueue-enrichment.ts:216`](../src/lib/apify/enqueue-enrichment.ts)).

| Phase | Actor / method | Item qualifies when… | Produces | Cost (verified) |
|---|---|---|---|---|
| **profiles** | `harvestapi~linkedin-profile-scraper` (by URL) ([`profile-harvestapi.ts:4,58-63`](../src/lib/apify/providers/profile-harvestapi.ts)) — feeds `urls: [linkedin_url]` | has `linkedin_url` | live profile + email | $0.004/profile, **$0.01 with email** (mode used) |
| **domains** | `harvestapi~linkedin-company` ([`company-harvestapi.ts:4`](../src/lib/apify/providers/company-harvestapi.ts)) + inline web-lookup discovery for name-only items | has a company LinkedIn ref, OR name-only w/ discovery on | `company_domain` | $0.004/company |
| **naming** | decision-maker `enrichBusiness` — L1 reads the site, **L2 web-search = Perplexity Sonar ONLY** (no Claude fallback; skipped without a Perplexity key) ([`decision-maker/index.ts:68`](../src/lib/decision-maker/index.ts), [`layer2.ts`](../src/lib/decision-maker/layer2.ts)) | name-less, company-named, no email ([`route.ts:2418-2432`](../src/app/api/cron/run-apify-enrichment/route.ts)) | owner name + title | Perplexity ~$0.015/business |
| **waterfall** | size-band method: `site_scrape` / `pattern_mv` / `bovi` ([`waterfall-routing.ts:20-35`](../src/lib/enrichment/waterfall-routing.ts)); name-less → forced `site_scrape` | has a domain | generic + personal email | site_scrape ~$0.003/lead; pattern_mv ≈ MV credits |
| **activity** | `harvestapi~linkedin-profile-posts` ([`activity-harvestapi.ts:7`](../src/lib/apify/providers/activity-harvestapi.ts)) | has `linkedin_url` ([`route.ts:2450-2455`](../src/app/api/cron/run-apify-enrichment/route.ts)) | posting-recency score | $0.002/post |
| **verify** | Million Verifier | has an email | verified status | ~$0.0037/decisive; catch-all/unknown/error **free** ([`pattern-mv.ts:68-72`](../src/lib/enrichment/pattern-mv.ts)) |
| **complete** | — | — | finalize outcome ledger | — |

### Which phases actually fire, per vein (the auto-routing)
Because phases self-skip when no item qualifies, the lead's DATA decides the path:

- **LinkedIn lead** (has `linkedin_url`): **profiles** (primary email source — scrapes the profile by URL), domains (company domain), waterfall (**fallback** for profiles that returned no email), activity (post recency), verify.
- **Maps lead** (name-less business, no `linkedin_url`): profiles → **skips** (no URL); **domains** → web-lookup discovery (name → domain); **naming** → owner-name discovery (if the add-on is on); **waterfall** → `site_scrape` (generic info@) + `pattern_mv` for items naming just named; activity → **skips** (no URL); verify.

---

## 4. Where each email actually comes from (the part that was gotten wrong)

- **LinkedIn personal email:** PRIMARY = the **profiles phase** (`linkedin-profile-scraper`, by URL) ([`profile-harvestapi.ts:92,112-119`](../src/lib/apify/providers/profile-harvestapi.ts)). FALLBACK only = `pattern_mv`/`site_scrape` in the waterfall when the profile scrape returned no email.
- **Maps generic email (info@):** the **`site_scrape`** actor (`site-contact-scraper`) reads the company website; the generic inbox is backfilled onto `contacts.email` ([`run-apify-enrichment/route.ts:1893-1910`](../src/app/api/cron/run-apify-enrichment/route.ts)).
- **Maps personal email:** **naming** finds the owner → **`pattern_mv`** guesses `first.last@domain` and Million Verifier confirms the deliverable one ([`pattern-mv.ts:40-66,106-166`](../src/lib/enrichment/pattern-mv.ts)).
- **Million Verifier is verify-only, never a finder.** It also runs as the pre-send gate in `run-native-sequences`.

---

## 5. The merge / cross-feed (the unification substrate)

- **Join key = the LinkedIn URL.** It's already the dedup key on import ([`linkedin-save` dedup by `lower(linkedin_url)`](../src/app/api/admin/prospecting/linkedin-save/route.ts)) and the input key of the profiles phase.
- **The URL→live-profile machinery already exists** — the profiles phase feeds `linkedin_url` into `linkedin-profile-scraper`. So a LinkedIn URL surfaced from ANY source (e.g. compass's `linkedinProfile` on a Maps lead) can be scraped live for $0.01, which corrects a stale/wrong DB match (the "franchise CEO" mismatch).
- **To cross-feed Maps → LinkedIn:** populate `linkedin_url` on the Maps contact (from compass's business-leads add-on), and the existing profiles phase scrapes it. The wiring is populating the field, not building the scraper.
- Shared substrate already in place: the `geo_places` gazetteer (both pickers), this enrichment engine, the `contacts` table, and the delivered-outcome ledger.

---

## 6. Full actor + cost reference (verified via Apify API 2026-08-28)

| Actor | Vein / phase | Bills | Price (our-ish tier) |
|---|---|---|---|
| `compass~google-maps-extractor` | Maps sourcing | per place | ~$0.004/place |
| `harvestapi~linkedin-profile-search` | LinkedIn sourcing | per search page / profile | $0.10/25 · $0.004 full · $0.01 +email |
| `harvestapi~linkedin-profile-scraper` | enrich: profiles | per profile | $0.004 · **$0.01 +email** |
| `harvestapi~linkedin-company` | enrich: domains | per company | $0.004 |
| `harvestapi~linkedin-profile-posts` | enrich: activity | per post/reaction/comment | $0.002 (·$0.001 no-result) |
| decision-maker (Anthropic/Perplexity) | enrich: naming | per business (LLM tokens) | ~$0.015 Perplexity / ~$0.06 Claude |
| `site-contact-scraper` (`indispensable_nonagon`) | enrich: waterfall (site_scrape) | per place scraped | ~$0.003 |
| pattern_mv + Million Verifier | enrich: waterfall / verify | per decisive verification | ~$0.0037 (catch-all/unknown free) |

---

## 7. Standing rule

- Answer flow questions from this doc + the cited code, never from memory.
- Any change to a sourcing actor, an enrichment phase/provider, or the phase state
  machine updates this doc in the same change.
- If a claim here can't be traced to the cited line, treat it as stale and re-verify.
