# RESUME: Google Maps prospecting vein + niche presets + owner-name add-on + margin ledger

> Self-contained handoff (2026-08-25). The Maps prospecting vein is CODE-COMPLETE,
> **browser-verified + full-pipeline e2e-verified, COMMITTED & PUSHED to master**
> (auto-deploys to prod). Migrations `00078`/`00079`/`00080` are applied to the live DB.
> Written for continuing on another machine — see "Moving to another computer" below,
> and follow the session-start protocol in CLAUDE.md first.

## Why this exists

Second prospecting vein alongside LinkedIn — the "no stone unturned" pitch (two veins,
LinkedIn AND Google Maps). Maps surfaces SMBs with no LinkedIn presence; their leads are
company inboxes/phones (at that business size the owner reads info@ — as good as emailing
the director), optionally upgraded to the owner's *personal* email via the new owner-name
add-on. Feeds the hyper-focused-organic-marketing plan: niche FB groups → themed landing
pages → the tool pre-set per industry (presets carry a global tier + slug for that).

## Owner decisions (2026-08-25)

- **Source:** Apify `compass~google-maps-extractor` (~$4/1k places; Scrap.io canceled).
- **Default depth:** generic email + phone (our `site_scrape`); **owner-name = per-search add-on**.
- **Funnel (eventual):** self-serve accounts + quotas (follow-up plan; NOT built here).
- **Pricing:** outcome-tiered per lead, mid-market — record ~$0.05 · +generic email ~$0.10 ·
  +owner name ~$0.20 · +verified personal email ~$0.30 (marginal cost $0.01–0.04/lead →
  ~85–95% margin). This build lays the ledger; billing enforcement = follow-up.
- **The two veins STAY SEPARATE tabs in Prospecting for now** (owner call, 2026-08-25).
  Parked idea for later: "one singular search" = keep Maps as the business-first entry
  and add a **LinkedIn-company-lookup method inside the naming phase** (join by domain,
  pull the senior person at that company) — an opt-in enrichment layer, NOT a fused
  two-way search (entity-resolution between veins was rejected as fuzzy). Note honestly:
  the naming phase is the right seam but currently hardcodes `enrichBusiness`; a LinkedIn
  method there is real new code (a provider-style addition), not a toggle. The pure
  LinkedIn ICP search stays its own route regardless (enterprise targeting ≠ Maps).

## Architecture

Maps is a table-for-table sibling of the LinkedIn vein; the enrichment engine is SHARED,
gaining one opt-in phase (naming):

```
maps_searches ──run-maps-searches cron──► compass~google-maps-extractor
  (start→poll→ingest; lease, cost_usd, 1-active/org)
  └─ auto-import (importMapsPlaces, dedup by google_place_id) → contacts
       {company_name, company_domain, company_phone, google_place_id, source:'maps-prospecting'}
     + enqueueEnrichment
run-apify-enrichment phases: profiles(skip) → domains(skip: has domain; website-less →
  existing domain-discovery) → NAMING (opt-in) → waterfall (name-aware: named→pattern_mv,
  nameless→site_scrape + generic-inbox backfill) → activity → verify → complete(ledger)
```

## Compass actor facts (probed live 2026-08-25)

- Charge events: `place-scraped` (primary, tiered FREE $0.005 / BRONZE $0.004 / SILVER
  $0.003 / … / DIAMOND $0.0008), `filter-applied` (~$0.001/place × #filters),
  `place-details-scraped` ($0.002), `contact-details-scraped`. We use ONLY `place-scraped`
  (detail pages + contacts enrichment OFF; closed places dropped client-side; filter events
  only when the user sets a website/min-rating filter).
- `website` enum: `allPlaces | withWebsite | withoutWebsite` (default allPlaces).
- Output: `placeId, title, categoryName, categories[], website, phone, phoneUnformatted,
  address, street, city, state, postalCode, countryCode, location{lat,lng}, totalScore,
  reviewsCount, permanentlyClosed, temporarilyClosed, claimThisBusiness, url`. No email.

## Files

**New:** `supabase/migrations/00078_create_maps_searches.sql` (+ `contacts.google_place_id`),
`00079_enrichment_naming_phase.sql` (naming phase + `outcome_counts`/`delivered_counts`),
`00080_create_maps_search_presets.sql`; `src/lib/apify/sourcing/maps-search.ts`,
`src/lib/apify/import-maps-places.ts`, `src/lib/enrichment/waterfall-routing.ts`,
`src/lib/enrichment/outcomes.ts`; `src/app/api/cron/run-maps-searches/route.ts`;
`src/app/api/admin/prospecting/{maps-search,maps-searches,maps-searches/[id],maps-save,maps-search-presets,maps-search-presets/[id]}/route.ts`;
`src/app/(dashboard)/admin/prospecting/maps-search-panel.tsx`;
`scripts/test-waterfall-routing.ts` (19/19).

**Modified:** `src/app/api/cron/run-apify-enrichment/route.ts` (naming phase `runNamingBatch`,
name-aware `seedWaterfallItems`/`finishWaterfallMiss` + generic backfill, `finalizeOutcomes`,
imports the shared routing module), `src/lib/apify/enqueue-enrichment.ts` +
`src/app/api/admin/contacts/enrich/start/route.ts` (`wantWaterfallOnly`/`wantNaming`,
`run_naming`, seed-at-insert edges), `src/lib/apify/providers/waterfall-scrape.ts`
(`pickPersonEmail` name-less branch), `src/lib/apify/{auth,columns,pricing,live-pricing}.ts`,
`src/app/api/admin/enrichment/pricing/route.ts`, `src/types/app.ts` (MapsPlace/MapsSearch,
EnrichmentPhase +naming, EnrichmentAddons +naming, EmailProviderId +decision_maker,
run/item fields), `src/lib/notifications/actor-failure-alert.ts` (+maps_search kind),
`vercel.json` (+run-maps-searches), `src/app/(dashboard)/admin/prospecting/page.tsx`
(two-panel shell; Scrap.io UI removed), `pipeline-status-panel.tsx` +
`components/contacts/enrichment-run-banner.tsx` + `contacts/page.tsx` (naming stage/checkbox).

## Verification done

- `npx tsc --noEmit`: 0 new app-code errors (pre-existing baseline unchanged).
- Unit: waterfall-routing 19/19, pattern-mv 9/9, domain-discovery 30/30.
- Live Apify (from the sandbox, org key read from DB): compass I/O + pricing; Maps
  sourcing → parse → import → dedup (8 med spas, re-import 0); site_scrape on a name-less
  trades domain set (commercial cleaning, Houston: 5/5 scraped at free `ok_http` tier
  $0.0025, 2/5 a generic email → backfill, 5/5 a phone, 2 name-less person emails).

## Post-review additions (2026-08-25, adversarial pass — same session)

- **Delivered-outcome radial** in the Maps panel (`MapsOutcomeRadial`): exclusive
  best-tier buckets per lead (personal / company inbox / phone-only / none + verified
  sub-count), fed by new `tier_*` keys the ledger now writes (`bestTier` in
  `src/lib/enrichment/outcomes.ts`; unit-tested `scripts/test-outcomes.ts` 22/22 —
  tiers are exclusive and sum to records). Renders once a search's leads finish an
  enrichment run (delivered_counts populated).
- **"Already in CRM" flag**: per-row badge + count line in the results table (RLS-scoped
  lookup by `google_place_id`) — the visibility guard for compass having no server-side
  blacklist (re-pulls re-pay for owned places).
- **vercel.json**: removed the two dead cron schedules (`run-prospect-searches`,
  `run-decision-maker-enrichment`) per the approved plan; route files/tables still
  present for Phase-6 deletion.
- **Preset provenance**: the panel now stamps `preset_slug` onto searches started from a
  preset. Fixed an invalid `export` from the presets route file (route modules may only
  export handlers/config; was masked by `ignoreBuildErrors`).

## ✅ Browser pass + FULL E2E — DONE (2026-08-25, pre-push)

Both former blockers were cleared and everything ran live through the real app:

- **Env fix that unblocked it:** the resident dev server's `prettier/plugins/html`
  module-not-found was NOT stale cache — `node_modules` was missing `prettier`
  (stale install; the lockfile was already correct). `npm install` fixed it, no
  lockfile change. If dev 500s with "Can't resolve 'prettier/plugins/html'" (or any
  module-not-found through `@react-email/render`/`resend`): run `npm install` first,
  THEN suspect `.next` staleness.
- **Browser pass (dev preview, logged in via `/app/api/dev/login`):** both Prospecting
  tabs render; the Maps panel's niche packs add chips, location/filters/add-ons work,
  the live estimate computes ("Est. ~$2.00 for 250 leads (~$0.008/lead)"), presets +
  prior-runs cards render. LinkedIn panel unaffected.
- **Full pipeline e2e (real money, real DB):** search "commercial cleaning service ·
  Dallas, TX · 12" via the real route → `run-maps-searches` cron start→poll→complete →
  **auto-imported 12 to Contacts → enrichment auto-started** → domains phase correctly
  no-op'd (11 had domains; 1 website-less place hit discovery's no-key path and
  finished `not_found` with the config note — fail-soft as designed) → waterfall
  seeded all 11 name-less items to `site_scrape` (name-aware routing live) → scrape
  harvested **3 found / 8 miss**: 3 generic inboxes backfilled into `contacts.email`
  with `kind: company_generic` provenance; all 12 got `company_phone`.
- **Ledger live:** run `outcome_counts` + search `delivered_counts` both stamped
  `{record:12, phone:12, company_email:4, tier_company:4, tier_phone:8}` — exclusive
  tiers sum to records. The panel's radial rendered these real numbers ("4 of 12 ·
  Company inbox 4 · Phone only 8"), and every row showed the **In CRM** badge
  ("12 of 12 already in your CRM").
- **Shared-domain semantics observed live:** two Dallas listings shared one website
  (`ccleaning.com`); the first claimed `info@` (backfill "found"), the second kept it
  as `company_email` reference but stayed email-less — the org's one-contact-per-email
  invariant, working as designed.
- The 12 imported Dallas janitorial leads were **kept** (real usable leads, tagged
  `maps`/`prospecting`, source `maps-prospecting`).

**✅ Naming phase LIVE-VALIDATED (2026-08-26)** — driven locally through the real crons
(dev login + CRON_SECRET tick loop; env `ANTHROPIC_API_KEY` fallback, org key still
unset). Results on the 12 Dallas leads (9 email-less in scope): **6/9 owner names**
(Traci Haws/AHI, Ernesto Ramirez/AJT, Sarah Boltz/Corporate Building Services,
Gerardo Garza/Embassy, Raquel Nipp/Raquel's, + 1 artifact "Chat kiat"/CBSI) and
**3/9 MV-`ok` verified personal emails** (tracihaws@ahifs.com, eramirez@ajtjanitorialsvc.com,
sboltz@ccleaning.com — the last on the shared ccleaning.com domain, i.e. the unpinned-GMB-
website attribution risk, see the domain-pinning next step). 2 more died on catch-all
domains (now recoverable via the include-catch-all add-on), 1 indeterminate.
- **Bug found + fixed by this run:** both Claude web_search tool declarations lacked the
  required `name: "web_search"` field → every Layer 2 / domain-discovery call 400'd
  (run 1 went 0/9). Fixed in `layer2.ts` + the discovery caller (commit `e07a0fd`).
- **All 6 names came from Layer 2 web search; Layer 1 site-reads found 0/9** — small-biz
  sites don't name owners. Measured Layer 2 cost ≈ $0.06–0.07/business on the Claude
  web-search path (token-only accrual; per-search fees uncounted), ~4× the
  `NAMING_COST_USD` $0.015 estimate. **Perplexity key = the economics lever** (~5–10×
  cheaper) before scaling; the code already prefers it when present.
- Validation spend: two runs, ~$0.68 accrued (~$0.75–0.90 true incl. unmetered search
  fees) vs a $0.55 approved cap — the overrun drove the always-ask-budget rule now in
  session memory.

## Known niggles (small, non-blocking)

- `maps_searches.cost_usd` shows the compute-only figure (e.g. $0.00005 for a 12-place
  run) because compass posts pay-per-event charges AFTER the completion poll — the same
  settle-lag `reconcileRunCost` fixes for enrichment runs; the maps/linkedin sourcing
  crons have no reconcile pass. True spend still shows in the Apify spend card. Fix =
  copy the reconcile pattern into both sourcing crons (small follow-up).
- A prior-run click renders cached results instantly; the radial appears only once its
  leads have been through a completed enrichment run (delivered_counts stamped).

## Moving to another computer (do this first)

1. Clone/pull `LeadStart/LeadStart` master; run the CLAUDE.md session-start protocol.
2. `npm install` (see the prettier note above — a stale node_modules is the known trap).
3. **`.env.local` is NOT in git** (`.env*` ignored) — copy it from the previous machine.
   It carries: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ACCESS_TOKEN` (migrations via
   `scripts/supabase-sql.mjs`), `DEV_AUTOLOGIN_EMAIL` (dev login), and a local
   `CRON_SECRET` (added 2026-08-25 so cron routes are curl-able in dev).
4. Dev: `npm run dev` → `http://localhost:3000/app/api/dev/login` → sidebar →
   Prospecting → Business (Google Maps).
5. Org keys live in the DB (Settings → Integrations), not env: Apify + Million Verifier
   are saved; **Anthropic/Perplexity are NOT** (naming + domain-discovery need one).

## Known trade-offs (honest)

- `run-maps-searches` is ~90% a clone of `run-linkedin-searches` (shared async-search runner
  extraction is a flagged follow-up). `MapsPlace`/`maps_*` deliberately don't reuse the
  Scrap.io `ScrapioBusiness` type. Compass has no server-side blacklist → overlapping
  searches re-pay for places already in the CRM (mitigation: preset discipline + the
  place-id dedup protects the CRM, not the spend). `delivered_counts` is eventually-consistent
  (merge-add across runs; a rare manual re-enrichment can double-count).

## What's next (priority order)

1. ~~Activate naming~~ **DONE 2026-08-26** (see the validation block above). Follow-ons
   it produced, in order: (a) ~~save a **Perplexity key** in Settings → Integrations~~ **DONE**
   (key wired 2026-08-28; Layer 2 is Perplexity-only, no key = no-op); (b) save the **Anthropic org key** too (the validation ran on
   the dev env fallback, so prod naming is still keyless); (c) ~~correct `NAMING_COST_USD`
   (and the Maps panel's "~$0.02/lead" copy)~~ **MOOT** ($0.015 + MV ≈ $0.02/lead
   is right now that Layer 2 is Perplexity-only);
   (d) **domain pinning** at the waterfall seam — reuse `nameTokenMatch` +
   `confirmViaHomepage` from domain-discovery on GMB-supplied websites (the
   sboltz@ccleaning.com shared-domain attribution is the live example); (e) the
   **send-risky-last dispatch rule** in run-native-sequences for catch-all contacts
   (verified-clean sends drain first, small per-mailbox daily risky cap).
2. **The monetization funnel (next plan — the big one):** themed niche landing pages
   (`/lp/<slug>` resolving the global preset tier) → self-serve signup/tenancy →
   billing enforcement priced against the delivered-outcome ledger. Hooks are ready:
   global preset tier + slug, `delivered_counts`/`outcome_counts`, and the repo's real
   Stripe machinery (quotes → Checkout → webhooks — PROJECT_STATUS's old "Stripe
   placeholder" note was stale). Open pre-work decision: data-resale/ToS posture for
   selling Maps/LinkedIn-derived data to third parties.
3. **Small follow-ups:** cost settle-lag reconcile in the two sourcing crons; shared
   async-search runner (maps/linkedin cron are ~90% clones); Phase 6 Scrap.io code
   deletion (`src/lib/scrapio/`, legacy prospecting routes + the two de-scheduled
   crons — UI already removed); fold LinkedIn presets into `maps_search_presets.kind`
   if/when convenient.
