# Apify Actor Cost Registry, the canonical spend reference

> Created 2026-08-30 after a $14.17 probe run against a $5 authorization (see
> Incident log). **No paid actor run happens without following the pre-run
> protocol below. No exceptions, no "small test" shortcuts.**
>
> Prices below were pulled LIVE from the Apify API (actor `pricingInfos` +
> default-build input schemas) on 2026-08-30, at our plan tier
> (**Starter → BRONZE** event prices). Re-pull any time with
> `node scripts/pull-actor-costs.mjs`, never trust this file over a fresh pull,
> and never trust a field NAME over its schema description.

---

## THE PRE-RUN PROTOCOL (mandatory before ANY paid run)

1. **Pull the actor's live pricing + input schema** (`node
   scripts/pull-actor-costs.mjs <actorId>`). Free, ~10 seconds.
2. **Read the schema description of EVERY input you will send.** Cap/limit
   semantics come from the schema TEXT, never from the field name and never
   from our own code comments. (The $14.17 lesson: `maximumLeadsEnrichmentRecords`
   is a cap **per place**, not per run.)
3. **Enumerate every charge event and write the worst case**: for each event,
   the maximum count your input permits × our-tier price. If any event's count
   is not bounded by an input you control, you do not have a cap, do not run.
4. **Worst case ≤ the owner's authorized budget, or don't run.** Stop and
   re-ask. An estimate is not a cap; only a bounded worst case is.
5. **After the run, reconcile** `chargedEventCounts` against the prediction.
   Any event that charged differently than predicted gets written into this
   file's Incident log the same day.

---

## Our-tier event prices (BRONZE / Starter), verified live 2026-08-30

### `compass~google-maps-extractor` (Maps sourcing), PAY_PER_EVENT

| Event | Our price | Charged per | Bounded by |
|---|---|---|---|
| `place-scraped` | $0.004 | place returned | `maxCrawledPlacesPerSearch`, **PER SEARCH TERM** (total = terms × cap; our `baseInput` divides the target across terms) |
| `filter-applied` | $0.001 | place × EACH filter | sending `website` / `placeMinimumStars` / `categoryFilterWords` (that's why we drop closed places client-side instead) |
| `place-details-scraped` | $0.002 | place | `scrapePlaceDetailPage: true` (we keep false) |
| `contact-details-scraped` | $0.003 | place | `scrapeContacts: true` (we keep false, our site_scrape is cheaper) |
| `lead-scraped` | $0.0075 | **person found** (pay-on-hit; zero-lead places charge $0) | `maximumLeadsEnrichmentRecords`, ⚠️ **cap is PER PLACE** ("Maximum leads per place"). One chain place returned 400 records. Uncapped worst case is unbounded. Always ≤3. `leadsEnrichmentDepartments` can filter server-side (miscategorization caveat). |
| `lead-email-verified` | $0.004 | decisive verification (valid/invalid/disposable; catch-all/unknown free) | `verifyLeadsEnrichmentEmails: true` (we keep false, MV is $0.0037) |
| `social-profile-scraped` | $0.01 | ⚠️ UNRESOLVED, event text says "flat per 1,000 profiles", price field says $0.01; do NOT enable without pinning this | `scrapeSocialMediaProfiles` (all false) |
| `apify-actor-start` | $0.00005 | GB of run memory | fixed |

Worst case for our standard sourcing run: `places × $0.004 (+ places × $0.001 ×
n_filters if filters set) (+ places × 3 × $0.0075 if the LinkedIn-people add-on
is on)`. Measured real (7 runs, 298 places): **$0.0043/place** all-in.

### `harvestapi~linkedin-profile-search` (LinkedIn sourcing), PAY_PER_EVENT

| Event | Our price | Charged per |
|---|---|---|
| `search-page` | **$0.10** | search RESULTS PAGE (up to 25 short profiles), ⚠️ charged per page opened, NOT per profile kept |
| `full-profile` | $0.004 | profile opened (mode Full) |
| `full-profile-with-email` | $0.01 | profile opened (mode Full + email) |

⚠️ **The page-floor trap (measured):** a 2-result search still pays full pages -
we measured **$0.55/profile at n=2** vs $0.0118/profile at n=100. Never run
tiny profile-searches; batch ≥100 or don't source via LinkedIn. Bound with
`maxItems` (total profiles, verified semantics: "stop when limit reached").
Worst case: `ceil(maxItems/25) × $0.10 + maxItems × (0.004 | 0.01)`.

### `harvestapi~linkedin-profile-scraper` (enrichment "profiles" phase), PAY_PER_EVENT

| Event | Our price | Charged per |
|---|---|---|
| `profile` | $0.004 | profile URL scraped |
| `profile_with_email` | $0.01 | profile URL scraped w/ email discovery (the mode we use) |

Bounded by the URL list we send. Measured real: $0.0072/profile avg.

### `harvestapi~linkedin-company` (enrichment "domains" phase), PAY_PER_EVENT

`apify-default-dataset-item` **$0.004/company**. Bounded by the company list we
send. Measured real: $0.0040.

### `harvestapi~linkedin-profile-posts` (enrichment "activity" phase), PAY_PER_EVENT

| Event | Our price | Charged per |
|---|---|---|
| `post` | $0.002 | post scraped (we send `maxPosts: 1`, flow map's "1 post sampled") |
| `reaction` | $0.002 | ⚠️ EACH reaction, only if `scrapeReactions: true` (MUST stay false; a viral post = hundreds of events) |
| `comment` | $0.002 | ⚠️ EACH comment, only if `scrapeComments: true` (MUST stay false) |
| `no-result` | $0.001 | profile with no posts |

Worst case with our settings: `profiles × $0.002`.

### `indispensable_nonagon~site-contact-scraper` (our actor; waterfall site_scrape), raw compute

No PPE events, bills actual compute + any proxy/unblocker usage.
`maxPagesPerDomain` default 6 bounds crawl size. Measured real (12 runs,
52 sites): **$0.0026/site**; browser-tier escalation can reach ~$0.01/site.

### `bovi~email-finder-bulk` (opt-in waterfall fallback), PAY_PER_EVENT

`email-found` **$0.004851/found** (pay-on-hit; code's `BOVI_COST_USD = 0.02` is
a stale over-estimate). Bounds: `maxPerDomain` (default 3), `maxAlternatives`
(default 5, Mode A), `maxItems` (total, 0 = UNBOUNDED, always set it).

---

## Non-Apify per-unit costs (same discipline applies)

| Service | Our price | Charged per | Notes |
|---|---|---|---|
| Million Verifier | ~$0.0037 | decisive verdict (ok/invalid/disposable) | catch-all/unknown/error FREE; 10K-bundle basis, tiered ~8× down to $0.00055 at 1M (owner call: quote the 10K rate) |
| Perplexity (naming L2) | ~$0.015 | business looked up | ceiling incl. per-request search fee |
| Findymail | $0.049 | email FOUND (pay-on-hit) | entry tier $49/1k; bulk $249/15k ≈ $0.017; misses free, bounces refunded |
| TuBe scan | $0.034 | lead scanned | app-side AI-visibility scan; the biggest single per-lead line item, scan only qualified+contactable leads |

## Fixed floor

**Apify Starter: $29/month** with $29 usage credit included; overage bills
beyond it. At low volume the floor dominates per-lead cost (60 leads ≈ 48¢/lead
before any event fires). Amortize with volume; check remaining credit before
big runs (`/users/me/usage/monthly`).

---

## Incident log

- **2026-08-30, $14.17 spent on a $5 authorization** (compass business-leads
  probe, run `phplPwGZ7lGaE2Yv7`). Cause: `maximumLeadsEnrichmentRecords: 400`
  sent as a believed per-RUN cap; schema says **per PLACE**; chains returned
  full rosters (1,836 `lead-scraped` × $0.0075). The same information at cap 3
  costs ~$1.02. Produced this registry + the pre-run protocol. Rule: schema
  text before spend, always.
- **2026-08-24, vdrmota $3.96, aborted** (free-tier contact-info scraper,
  ~$1.00/company, filled 0 fields). Led to vdrmota's full removal.
- **(standing) profile-search page floor**, $0.55/profile measured at n=2.
  Never source LinkedIn in small batches.
