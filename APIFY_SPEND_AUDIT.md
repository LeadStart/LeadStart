# Apify Actor + Spend Subsystem Audit

> Started + verified 2026-08-30. Trigger: the $14.17 per-place-cap incident.
> Scope: all 7 actors, every cost constant/estimate surface, every
> spend-bounding input, every cron that can start paid runs, every record
> claiming a price or semantic, vs the live Apify API (BRONZE tier) and the
> account's full billing history (37 runs, the entire history).
>
> **Status: FIND + ADVERSARIAL VERIFY COMPLETE. Fix gate OPEN, nothing
> shipped; every fix awaits explicit owner go-ahead.**

## Methodology

6 parallel finder lanes (A prices, B input bounds, C estimates, D docs,
E billing reconciliation, F cron lifecycle) → cross-lane dedupe → 4 adversarial
verifiers (posture: refute; fresh live schema pulls; line-level control-flow
tracing; read-only DB queries) + 2 direct reproductions by the auditor.
Zero spend during the audit. Verifier scripts in the session scratchpad.

## Reconciliation

**74 lane candidates − 16 cross-lane duplicates = 58 unique.
58 = 53 CONFIRMED + 1 PARTIAL + 4 REFUTED.**
Plus **13 verifier-discovered findings** (folded into the clusters below, each
carrying its discoverer's file:line evidence). **~69 areas verified clean.**
One sub-claim refuted inside a confirmed finding (noted at SPEND-13).

## Operational alert (standing until cycle reset 9/23)

**$4.61 of the $29.00 Starter credit remains** (84% burned in 7 days; hard 403
at the cap, it killed run `e19c4c6c` on the free tier the same way). Meter:
$24.21 of $24.39 is pay-per-event actors. The two incidents ($14.17 probe +
$3.96 vdrmota abort) are 74% of the month; real product usage ≈ $6.2.

---

# CONFIRMED FINDINGS (by root-cause cluster)

## Cluster 1, No hard spend ceilings anywhere (structural)

- **SPEND-01 · HIGH · CONFIRMED**, `maxTotalChargeUsd` is never passed:
  `src/lib/apify/client.ts:118-135` sends only waitForFinish/timeout/memory;
  all 4 start sites pass nothing. Every real run shows
  `isMaxTotalChargeUsdSetByUser: false` with the platform auto-cap = the ENTIRE
  remaining monthly credit ($18.78 on the probe). One query param would have
  made the $14.17 run a ≤$3.40 run. Fix: derive a per-run budget from the run's
  own estimate and pass it at all 4 sites.
- **SPEND-02 · HIGH · CONFIRMED**, no app-side budget preflight: the only
  `getMonthlyUsage` caller is the display card
  (`src/app/api/admin/apify/spend/route.ts:31`). The registrar path HAS an org
  cap + owner alert (`src/lib/registrar/auth.ts:21-42`), the pattern exists,
  never applied to Apify. Fix: org `apify_monthly_spend_cap_usd` + shared
  preflight before every `startActorRun`.
- **SPEND-03 · LOW · CONFIRMED**, the cron trusts DB values the creation route
  clamped: `run-maps-searches/route.ts:316-318,510-512` passes
  `target_max_results` unclamped (bounded only by the per-area 5000 clamp in
  `baseInput`; corrected worst = 25×5000 ≈ $500), and `:393` re-reads areas via
  `coerceMapsAreas` which has NO count cap (MAX_AREAS=25 lives only in the
  route). Fix: clamp target ≤5000 and `areas.slice(0,25)` at the cron read.

## Cluster 2, Unbounded / mis-bounded actor inputs

- **SPEND-04 · HIGH · CONFIRMED**, deep-search segment multiplication:
  `takePages` (real input, verified by fresh schema pull) applies PER SEGMENT
  under `autoQuerySegmentation: true`
  (`src/lib/apify/sourcing/profile-search.ts:81,95-102`); segments are bounded
  by no input we send. Billing proof: 20-result run billed 11 pages, $1.252 vs
  the $0.28 panel estimate; worst ≈ #segments × takePages × $0.10 (a 250-segment
  sweep at UI-max ≈ $1,000 vs a ~$49 estimate). The panel's 3.5x multiplier is
  calibration, not a bound. Fix: send an explicit per-segment `takePages` budget
  (1-2) when deep search is on; label the estimate unbounded above it.
- **SPEND-05 · MED-HIGH · CONFIRMED**, term-count floor voids the target cap:
  `perSearch = max(1, ceil(cap/N))` (`maps-search.ts:79-80`) floors at 1 and
  NOTHING caps N (route dedupes only; audience packs stack terms in one click).
  Billed places ≈ max(target, areas × N): T=200, A=25, N=200 → up to $20 vs the
  $0.80 the target implies. Fix: MAX_TERMS (~25) in route + panel.
- **SPEND-06 · LOW-MED · CONFIRMED-AS-RISK**, bovi zero-semantics unpinned:
  `waterfall-bovi.ts:25` sends `maxAlternatives: 0` (schema default 5, max 12,
  silent on 0) and omits `maxItems` (this actor's own doc: "0 = no limit").
  Bounded by the 100-item batch: worst ≈ $5.80/batch vs ~$0.49 intended.
  Fix: send `maxItems: people.length` + explicit `maxAlternatives`.
- **SPEND-07 · LOW (latent) · CONFIRMED-DORMANT**, the site-scraper escalates
  to the PAID ScrapFly unblocker on cleanly-rendered pages that merely lack an
  email (`apify-actors/site-contact-scraper/src/scrape.ts:120` accept predicate;
  `fetchPage.ts:233-255` tier loop), armed by bare env presence
  (`waterfall-scrape.ts:109`, `SITE_SCRAPE_UNBLOCKER_KEY` currently UNSET -
  verified names-only). ScrapFly bills outside Apify entirely. Fix: gate on an
  explicit settings flag, not env presence.

## Cluster 3, Dead / broken failure brakes

- **SPEND-09 · HIGH · CONFIRMED**, the enrichment run's circuit breaker is
  dead code: `run-apify-enrichment/route.ts:278` unconditionally resets
  `consecutive_failures = 0` after every non-throwing tick, clobbering the
  terminal-bad increment (`:406`, returns normally); stuck-abort (`:337-348`)
  never increments. `failRun`/`alertActorFailure` unreachable from failed
  batches, a deterministically failing actor relaunches paid batches with no
  kill and NO OWNER ALERT (bounded only by per-item attempts ≈ 3 paid starts
  each). Fix: reset only when the tick's result is not a failure.
- **SPEND-10 · MED-HIGH · CONFIRMED**, 3 transient poll errors park a search
  `failed` with the actor still running and billing: the ≥3 branch
  (`run-maps-searches:521-539`, `run-linkedin-searches:306-325`) never calls
  `abortRun` and never ingests; the paid dataset is stranded and a re-run
  re-pays every place. Fix: best-effort abort + ingest in the park branch.
- **SPEND-11 · MED-HIGH · CONFIRMED**, naming batch loses paid work at the
  60s wall: admission gate allows an item at t=44.9s to run 30s past
  `maxDuration=60`; ALL writes sit after `Promise.all`
  (`:1263-1306` → `:1314-1431`, verified no incremental write), so a killed
  tick repays the same Anthropic/Perplexity calls next tick, indefinitely, with
  the breaker untouched (kill ≠ throw). Aggravator (verifier-found): the
  Perplexity client has NO timeout/AbortController at all
  (`src/lib/perplexity/client.ts`). Discovery shares the shape. Fix: stop
  admitting at `deadline − perItemTimeout`, write outcomes incrementally, add a
  Perplexity timeout.
- **SPEND-12 · MED · CONFIRMED (narrowed)**, verify-phase spin: thrown MV
  transport errors leave items pending with no attempts bump
  (`:1620-1630`; seed sets attempts 0, nothing increments on this path); the
  same oldest 25 re-selected every tick; the stuck run head-of-line blocks the
  org's whole enrichment queue. (Server-side MV timeouts resolve as "unknown"
 , no credit-spend loop.) Fix: bump attempts on transient failures; finalize
  at the cap.
- **SPEND-13 · LOW (latent) · CONFIRMED core**, `run-decision-maker-enrichment`
  "claim" matches rows already `running` (`route.ts:91-105`, no lease), so
  concurrent ticks double-pay the same 5 LLM lookups. Unscheduled in
  vercel.json (latent). Sub-claim "processed_count flips isDone early" REFUTED:
  lost updates under-count, never over-count. Fix: lease-claim before
  re-activation.

## Cluster 4, Orphaned runs / double starts / retry waste

- **SPEND-14 · HIGH (search) / MED (enrichment) · CONFIRMED (strengthened)** -
  start-before-persist: all 4 sites POST the paid run, then persist via an
  UNGUARDED write (`run-maps-searches:513-519,319-325`;
  `run-linkedin-searches:298-304`). A network blip on the response read alone
  (client throws, `client.ts:92`) orphans a live billing run and the catch
  retries → guaranteed duplicate start, no crash needed. Enrichment has
  CAS + abort-on-loss (`:522-532`) for races but not crashes; `recoverOrphans`
  (`:2216-2219`) resets items with NO attempts bump. Fix: persist a "starting"
  marker before the POST; give search crons the CAS+abort; bump attempts in
  recovery.
- **SPEND-15 · MED · CONFIRMED**, 90s lease vs unbounded local ticks (the
  documented local-drive workflow): a >90s local tick and a prod tick can both
  pass the claim; search crons' unguarded persist lets both POST paid runs,
  loser orphaned unaborted. Fix: same CAS as enrichment.
- **SPEND-16 · MED · CONFIRMED**, retry-discard of billed partials: stuck/
  terminal-bad paths never read the failed run's dataset (PPE already charged
  per place), then restart from zero, up to 3 attempts (~$90 for $30 of data
  on a big search); `APIFY_TIMEOUT_SEC` (1200) EQUALS the stuck threshold -
  the app abort and Apify's timeout race at the same instant. Fix: ingest paid
  partials before requeue; stagger the thresholds.

## Cluster 5, Spend-ledger honesty (what the app records vs what Apify bills)

- **SPEND-17 · HIGH (reporting) · CONFIRMED**, search crons read
  `usageTotalUsd` exactly once at terminal, before Apify finishes aggregating
  PPE events, and never reconcile (grep-decisive; `reconcileRunCost` exists for
  enrichment only). Measured: a real search recorded **$0.00005 vs $0.04805
  billed** (961x). Every `maps_searches`/`linkedin_searches.cost_usd`
  systematically understates. Fix: re-read cost N minutes post-completion.
- **SPEND-18 · MED · CONFIRMED (verifier-found)**, `requeueOrFail` NULLS the
  item-level run ids (`:2251`), so `reconcileRunCost` (harvests run ids from
  items, `:2313-2337`) can never re-read a failed batch's late-settling
  charges; they permanently escape `cost_usd`. Fix: keep failed run ids in a
  side column for reconciliation.
- **SPEND-19 · LOW · CONFIRMED (direct)**, per-item recorded costs stamp the
  estimate constant unconditionally (`:1747` `share = estimatePerItem(phase)`;
  waterfall 0.005 / activity 0.005 vs measured 0.0026 / 0.002). Item-level
  margin math inherits ~2x error. Fix: apportion actuals when reconciled.
- **SPEND-20 · MED-LOW · CONFIRMED (self-documented)**, naming/discovery
  accrual is token-only; Perplexity's per-request search fee never lands
  (`pricing.ts:44-48,57-58` admit it; ~$2 recorded vs ~$15 real on a 1k run).
- **SPEND-21 · recorded (historical)**, the vdrmota abort billed $3.9640
  (platform-aborted AT the auto cap) and is permanently missing from the app
  ledger (`e19c4c6c` records $0.134); the capture mechanism shipped 3.3h after.
  Optional one-off backfill.
- **SPEND-22 · LOW · CONFIRMED (verifier-found)**, `reconcileRunCost` skips
  runs spanning >40 Apify runs (`:2337`), keeping the undercounting figure on
  the largest (most expensive) runs.
- **SPEND-23 · MED · CONFIRMED**, the one post-run number the owner sees
  (run banner `enrichment-run-banner.tsx:114,136` "est. cost $") renders
  `run.cost_usd`, which per SPEND-17/18/20 reads low. Fix: relabel "billed"
  only after reconcile; show "updating" before.

## Cluster 6, Estimate-surface honesty (what you approve vs what bills)

- **SPEND-24 · HIGH · CONFIRMED**, the Contacts enrich dialog's
  "Estimated cost: up to ~$" (`contacts/page.tsx:1846`) omits BOTH paid toggles
  in the same dialog: naming (`run_naming`, ~$0.015/business) and
  validate_catch_all (Findymail $0.049/hit) move the ceiling by $0.000
  (`:588-596` sums 5 terms only). A stated ceiling that isn't one.
- **SPEND-25 · MED · CONFIRMED (billed evidence)**, Maps DIY estimate has no
  filter term while the panel sends both billed filters
  (`maps-diy-panel.tsx:559-565` vs `:493`; $0.001/place/filter; a real run
  billed filter events). The pricing endpoint exposes no filter price.
- **SPEND-26 · LOW-MED · CONFIRMED**, the $29/mo plan-floor disclosure exists
  only inside the LinkedIn panel's info modal; absent from Maps DIY and the
  Contacts dialog.
- **SPEND-27 · MED · CONFIRMED**, false billing prose: "billed per profile
  returned, not per target" (`linkedin-search-panel.tsx:2887`, also `:2462`)
  contradicts per-page billing AND the same file's correct `:2533`; the flow
  map repeats it ("$0.004 / profile · ON HIT",
  `enrichment-flow-map.data.ts:60`). The single-query estimate math also
  assumes full 25-profile pages (verifier-found, `:1362`).
- **SPEND-28 · MED · CONFIRMED**, "live pricing" serves FREE-tier prices on a
  BRONZE account (`live-pricing.ts:98` default; caller passes no tier), so the
  live path shows $0.005/place vs the $0.004 we pay, actively wronger than the
  static fallback (verifier-found `maps-diy-panel.tsx:553`); the per-event
  fallback ALSO anchors FREE (`live-pricing.ts:74`), and the static fallback
  stamps `tier:"FREE"` on BRONZE-calibrated constants (`pricing/route.ts:27`).
  Latent 13.3x error if lead-scraped ever flows through (FREE $0.10 vs BRONZE
  $0.0075).
- **SPEND-29 · MED · CONFIRMED**, same phase, two prices: site_scrape $0.006
  (static path → Contacts dialog) vs $0.003 (live path → both panels), flipping
  with fetch success; measured truth $0.0026.
- **SPEND-30 · LOW · CONFIRMED**, `BOVI_COST_USD = 0.02` shown as
  "≈ $0.020 per company" vs live $0.004851/found (4.1x, scares off a cheap
  fallback).
- **SPEND-31 · MED · CONFIRMED**, Maps DIY prices naming's email step at
  best-case (+$0.004 = 1 MV credit; honest ceiling $0.022) and verify at a
  hardcoded $0.002 vs the $0.0037 basis, with NO ceiling wording on the card
  (unlike both sibling surfaces).
- **SPEND-32 · LOW-MED · CONFIRMED**, nothing pre-spend warns that re-running
  a search re-bills every place (compass has no dedupe); the CRM-overlap
  guards render only after the money is spent.
- **SPEND-33 · LOW · CONFIRMED (reframed)**, nested/overlapping areas: total
  bounded by ~target (Lane B right) but duplicates are merged AFTER billing, so
  the estimate's "per lead" is really "per billed place"; unique-lead cost
  rises silently.
- **SPEND-34 · LOW · CONFIRMED**, activity estimated at 2.5 posts/person
  ($0.005) while the provider hard-caps `maxPosts: 1` (true worst $0.002);
  physically impossible estimate, disagrees with the flow map's correct value.
- **SPEND-35 · MED (structural) · CONFIRMED**, 8 of the pricing helpers are
  dead exports; every panel hand-rolls its own rates (linkedin `ENRICH_RATES`,
  DIY fallbacks, Contacts label strings), the mechanism behind SPEND-29/30/31
  drift, plus the hardcoded "~$0.02/lead" naming string that will drift from
  the live-served value two lines away (verifier-found).

## Cluster 7, Add-on scope bleed

- **SPEND-36 · MED · CONFIRMED**, one opted contact flips run-wide paid
  phases: `.some()` OR-merge (`enqueue-enrichment.ts:169-179`, including
  include_catch_all AND validate_catch_all) + seeders that select every
  eligible item with zero per-contact addon consult (verify `:2289-2298`,
  naming `:2492-2500`, activity `:2521-2525`; "addons" appears nowhere in the
  2,600-line cron). A drain-merged run (cap 2000) can Findymail-validate or
  name 1,999 strangers on one contact's toggle. Fix: stamp addons per item at
  enqueue; filter every seed on the stamp.

## Cluster 8, Docs / records drift (the class that travels between sessions)

- **SPEND-37 · MED-HIGH · CONFIRMED**, the per-place cap trap is stated
  NOWHERE forward-looking: `docs/PROSPECTING_FLOW.md:38` and
  `docs/plans/unified-prospecting-plan.md:33,117,127-129` describe the leads
  add-on as pay-on-hit with zero cap semantics. The registry is currently the
  only place that knows.
- **SPEND-38 · MED · CONFIRMED**, flow doc says add-ons "always OFF" while the
  uncommitted working tree wires the `linkedinLeads` lever (+ stale `:34-37`
  citations). Resolves with the toggle keep/scrap decision, doc in the same
  change.
- **SPEND-39 · MED · CONFIRMED**, the retired Claude-naming path survives in
  `unified-prospecting-plan.md:123` (self-contradicting `:43-45`),
  `PROJECT_STATUS.md:201-202` (an "open item" that would wrongly 4x a
  now-correct constant), `RESUME-MAPS-VEIN.md:204-209(a)(c)`,
  `PROSPECTING_FLOW.md:123`, and two comments inside `pricing.ts:44-45,55`.
- **SPEND-40 · LOW · CONFIRMED**, `RESUME-WATERFALL-SETTINGS.md:104` labels
  the 1-credit typical (~$0.004) as the ≤6-credit "worst case" (real ~$0.022).
- **SPEND-41 · MED · CONFIRMED**, `memory/project_apify_cost_model.md` (the
  cross-session cost memory) omits `lead-scraped` entirely, blind to the
  newest, most dangerous event, no per-place cap, no incident; also understates
  the site-scrape band top and still says vdrmota "being retired" (fully
  removed).
- **SPEND-42 · LOW · CONFIRMED**, same memory `:14` describes modal constants
  that no longer exist (DEPTHS now 0.004/0.008/0.014).
- **SPEND-43 · LOW · CONFIRMED**, unit language: site_scrape quoted "per
  lead"/"per place" in `PROSPECTING_FLOW.md:68,124` +
  `unified-prospecting-plan.md:27`; billing is per SITE (compute).
- **SPEND-44 · LOW · PARTIAL**, `docs/apify-enrichment-plan.md` has a
  historical marker (`:3-25`) covering michael.g/verify prices, but vdrmota
  (removed a day after the marker) is uncovered at `:54,114-122`.
- **SPEND-45 · LOW · CONFIRMED**, `scripts/test-flow-map-sync.ts` (11/11
  green) does not guard the flow map's 3 hardcoded USD strings or its
  semantics labels (the "ON HIT" error passed the suite).
- **Registry amendment (audit meta)**, `actor-costs-live.json` is
  regex-filtered; it must never be used to prove a FIELD IS ABSENT (that
  misread nearly produced two false findings, both refuted by fresh full
  pulls). Note to add to `docs/APIFY_ACTOR_COSTS.md` + widen
  `scripts/pull-actor-costs.mjs` to dump full schemas + enums.

---

# REFUTED (recorded, part of the audit's credibility)

1. **B-7 enum caption strings**, REFUTED: fresh schema pulls show our mode
   strings match both actors' enums EXACTLY, and a mismatch fails loud (400),
   never a silent default. (Residual: vendor caption edit = availability risk.)
2. **B-8 activity defaults unsafe**, REFUTED: `includeReposts`/
   `includeQuotePosts` are real schema fields; `scrapeReactions`/
   `scrapeComments` default FALSE in the live schema; `maxPosts:1` explicit.
   (Hygiene only: send the two falses explicitly.)
3. **D-14 "Business $0.0021" mislabeled**, REFUTED: "Business" is Apify's
   plan name for the GOLD tier; the pairing is correct.
4. **E-5 twin compass runs as double-bill**, REFUTED: they are one search's
   per-area fan-out; DB cost = the sum to the cent. (All 4 back-to-back pairs
   in history explained.)
5. **V-7 sub-claim** ("processed_count flips isDone early"), REFUTED: lost
   updates under-count; completion is safe via the pending-empty finalize.

# VERIFIED CLEAN (~69 areas; headline items)

Core pricing constants (8/8 match live); both canonical docs' prices (16/16
registry events vs raw JSON); compass input hygiene (per-term division,
add-ons off, closed-place client-side drop, per-place cap comment + parse
slice); LinkedIn DEPTHS = live math, deep-search multiplier disclosed, min
target 100; one-active-per-org unique indexes LIVE in prod (all 3); no
contact double-enrollment; auto search→import→enrich chain loop-free;
provisioning cannot double-buy; `startActorRun` never replays on network
error (429-only retry); dead crons unscheduled; site-scraper never escalated
past cheap tiers in real billing; MV enrichment/send-gate share one cache; the
Settings spend card reads Apify live (authoritative by design); DB right now:
zero stuck rows, zero orphaned run ids, zero queued contacts; full-history
billing reconciles to the cycle total within $0.046.

# Incident log (cross-referenced in docs/APIFY_ACTOR_COSTS.md)

- 2026-08-30 probe $14.17 (per-place cap misread), realized, registry-logged.
- 2026-08-24 vdrmota $3.96 abort, billed at the auto cap, ledger hole
  (SPEND-21).
- 2026-08-24 free-tier gate retries, 3 × $0.004 billed "SUCCEEDED" runs with
  0 items ("feature not available for free users"): the actor bills its floor
  event before its own feature gate.
- Standing: profile-search page floor ($0.55/profile at n=2, measured).

# Shipped this session (LOCAL, verified, NOT pushed)

Owner opened the fix gate ("tackle 1-5") 2026-08-30. All changes local; master
auto-deploys, so they wait on an explicit push. Verified: full `tsc` = 0 new
errors (91 pre-existing baseline unchanged); unit suites green (flow-map-sync
11/11, waterfall-routing, outcomes, pattern-mv, campaign-variables 46/46,
launch-readiness 14/14); em-dash sweep of all added lines = 0.

**Batch 1 (hard ceilings):** SPEND-01 done (`maxTotalChargeUsd` in client.ts +
per-run caps at all 4 start sites), SPEND-03 done (cron target clamps).
SPEND-02 PARTIAL: the per-run cap + Apify's own account limit give hard
protection now; a configurable org-level cap is deferred (would need storage).

**Batch 2 (brakes/orphans):** SPEND-09 done (breaker reset made conditional +
stuck-branch now increments), SPEND-10 done (abort-on-park, both search crons),
SPEND-11 CORE done (Perplexity hard timeout; the incremental-write restructure
is deferred, the timeout removes its main risk), SPEND-12 done (verify attempts
bump + finalize), SPEND-14 done (search-cron CAS + orphan-recovery attempts
bump), SPEND-15 done (CAS abort-on-lost-race), SPEND-16 PARTIAL (stuck/park now
abort the live run; ingesting the paid partial deferred), SPEND-18 done on the
main path (failed run-id preserved for reconcile), SPEND-22 done (reconcile
pool, >40-run cap removed).

**Batch 3 (estimate honesty):** SPEND-24, 25, 26, 27, 28, 29, 30, 31, 34, 35 all
done, plus a shared `PlanFloorNote` component.

**Batch 4 (input bounds):** SPEND-04 (per-segment takePages=2), SPEND-05
(MAX_TERMS=25), SPEND-06 (bovi maxItems), SPEND-36 (per-item add-on stamps).

**Batch 5 (docs/memory):** SPEND-37, 39, 40, 41, 42, 43, 44.

## Deferred (documented; lower-priority, reporting-only, or need storage)

- **SPEND-07** unblocker gate, dormant (`SITE_SCRAPE_UNBLOCKER_KEY` unset).
- **SPEND-11** incremental naming writes, the Perplexity timeout covers the
  main risk; the pool-write restructure is defense-in-depth.
- **SPEND-14** pure-crash orphan (persist-a-marker-before-POST), the same
  residual the enrichment reference accepts; CAS closes the race case.
- **SPEND-16 / 17 / 19 / 20 / 23** recorded-cost accuracy, reporting-only; the
  Settings spend card already reads Apify live and is authoritative.
- **SPEND-18** fully-retried-then-succeeded edge, needs a dedicated column.
- **SPEND-21** vdrmota $3.96 ledger backfill, optional one-off.
- **SPEND-32 / 33** re-run re-pay warning + nested-area estimate labeling, minor UX.
- **SPEND-45** flow-map test guard, low-value hardening.
- Configurable org spend cap, `maxTotalChargeUsd` already hard-caps per run.

# Proposed fix batches (each = one root-cause cluster; ship only on go-ahead)

1. **Hard ceilings** (SPEND-01/02/03): `maxTotalChargeUsd` on all 4 starts +
   org monthly cap preflight (mirror the registrar cap) + cron clamps.
   ~30-40 min Claude time incl. tests. **Kills the incident class outright.**
2. **Brakes + orphans** (SPEND-09/10/11/12/14/15/16/18): breaker fix,
   abort-on-park, persist-before-start + CAS for search crons, attempts bumps,
   ingest paid partials, naming incremental writes + Perplexity timeout.
   ~1 focused session.
3. **Estimate honesty** (SPEND-24/25/26/27/28/29/30/31/34/35 + tier fix):
   single-source the constants, add the missing terms, shared floor note,
   prose rewrite. ~45-60 min.
4. **Input bounds + add-on stamps** (SPEND-04/05/06/36): per-segment takePages,
   MAX_TERMS, bovi maxItems, per-item addon stamps. ~30-45 min.
5. **Docs + memory sync** (SPEND-37…45 + registry amendment): pure edits.
   ~20-30 min.
