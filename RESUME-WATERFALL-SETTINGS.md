# RESUME: Configurable enrichment waterfall (settings panel + pattern/MV finder + own scraper + size routing)

> **For the next session.** This doc is self-contained: decision history, hard evidence
> gathered 2026-08-24, architecture, schema, file-by-file work plan, verification, and
> the open decisions. Written at the end of a long session (2026-08-24) so a fresh
> session can execute without re-deriving anything. Follow the session-start protocol
> in CLAUDE.md first (git pull etc.), and read "Repo state" below — there IS
> uncommitted local work in the tree.

---

> **UPDATE 2026-08-24 — vdrmota FULLY REMOVED (owner call).** This doc's earlier
> "retire as default, keep as an option" decision is SUPERSEDED: vdrmota is gone
> entirely (provider, actor, registry, routing, `EnrichmentWaterfallMethod` +
> `EmailProviderId` union members, `vdrmota_max_leads` setting, settings-card
> option + lead-cap field, prospecting-panel labels). Default method is
> pattern_mv; bovi remains as the opt-in Apify fallback; site_scrape is ours.
> Stored org settings were migrated off vdrmota (coerced to pattern_mv on read).
> Historical vdrmota charges still appear in the Apify spend card — that's real
> billing data, intentionally not scrubbed. Ignore vdrmota mentions below; they
> are decision history.

## Why this exists — the evidence (all measured live on 2026-08-24, don't re-litigate)

The second-pass email waterfall (`vdrmota~contact-info-scraper`) is **wrong for our
need: too expensive, too blunt, and in its one real run it delivered nothing.**

**The $3.96 run that filled zero fields.** Apify run `aA4CZiMuIqH83Ygia` (ABORTED at
61s, our 60s route budget) charged `{"pages-scraped":30, "lead-scraped":32,
"lead-email-verified":8, "actor-start-gb":4}` = **$3.96**, dominated by `lead-scraped`
at **~$0.10/lead on the FREE Apify tier** (would be ~$0.005 on paid — a 20× tier
multiplier). Outcome in our DB: `found_emails_waterfall_count = 0`, zero contacts with
`email_provider='vdrmota'`, waterfall items 18 `null` / 5 `pending` / 0 ingested —
the abort happened before harvest, so even the 42 directory leads + 24 site emails it
DID fetch were discarded. It reached only 5 of our 18 domains.

**Why it's structurally blunt.** Input is just `{startUrls:[domain], maximumLeadsEnrichmentRecords:10, …}`
([src/lib/apify/providers/waterfall-vdrmota.ts](src/lib/apify/providers/waterfall-vdrmota.ts)).
Per company it crawls the site AND pulls **10 people from a people-database directory**,
hoping one matches our contact by first+last name; we keep at most 1 email and discard
the other ~95% of what we paid for. There is **no way to tell it "find only the missing
field for this specific person."** It also happily crawls wrong domains from upstream
noise (one commercial-cleaning contact resolved to `vistage.com`, a business-coaching
company — 10 leads charged for the wrong business).

**The app's estimates were ~100× off.** [src/lib/apify/pricing.ts](src/lib/apify/pricing.ts)
`WATERFALL_LEAD_COST_USD = 0.005` is used *per contact*; reality is per-LEAD × 10
leads/company × 20× free-tier multiplier ⇒ ~$1.00/company on free tier. Fix the
estimate math as part of Phase 1.

**vdrmota's directory is a database, not a scrape** (so "we'll Playwright it ourselves"
replaces only *part* of it). Evidence from its own output: `personId`/`companyId` are
MongoDB ObjectIds; `photoUrl` on `media.licdn.com`; normalized `seniority: c_suite`,
`departments[]`; personal work emails (`niels.lameijer@vistage.com`) that are NOT
published on the company site. A headless browser on the company site cannot produce
those. What a scrape CAN reproduce: the company-level `emails[]` (info@/sales@),
`phones[]`, socials — the actor's crawl half.

**Owner decisions locked in (2026-08-24):**
1. Retire vdrmota as the default waterfall (keep it registered as an option).
2. Personal work emails: **pattern-permutation + Million Verifier** (we already pay
   for MV; surgical; ~$0.002–0.004/contact).
3. Company-level data (generic email, phone): **our own scraper — HTTPS plain-fetch
   first, Playwright + stealth.js fallback**. For the small/local-business ICP
   (cleaning/janitorial/trades) a scraped `info@`/owner email is genuinely useful
   ("at least we will have SOMETHING").
4. **A settings panel to toggle all of this** (Settings → Integrations), including
   **company-size routing**: for larger companies the domain scrape is pointless
   (site won't carry the decision-maker's email — you get a dead role inbox), so
   route by employee count: big → pattern/DB only; small → scrape (+ pattern).
5. Execute in a fresh session; this doc is the handoff.

**Adjacent captured-but-discarded data to pick up while we're in here** (verified live):
`harvestapi~linkedin-company` (domain phase, already runs on every domain-less
contact) returns `phone: {number, extension}`, HQ `locations`, `employeeCount` — we
keep only website→domain. Capture company phone → `contacts.phone` (fill-only) and
persist `employeeCount` (it's the size-routing input).

---

## Target architecture

One waterfall phase, N pluggable **methods**, chosen per-item by org-configurable
routing:

```
waterfall phase (cron tick)
  └─ per pending item, advancePhase stamped waterfall_method ∈
       'pattern_mv' | 'site_scrape' | 'vdrmota' | 'bovi' | 'skip'
     based on org settings + employee_count band
  └─ worker batches items OF ONE METHOD per tick:
       apify methods  → existing start-run → poll → ingest (unchanged mechanics)
       direct methods → processed inline in the tick (pattern_mv: ≤50/batch)
```

- **pattern_mv (direct, new):** candidates from first/last/domain
  (`first.last@ → first@ → flast@ → f.last@ → last@ → firstlast@`), batch through
  the existing MV client ([src/lib/millionverifier/client.ts](src/lib/millionverifier/client.ts));
  first `ok` wins → `writeEmail(…, provider 'pattern_mv')`. `catch_all` never
  auto-writes unless the org toggles "accept catch-all guesses" (then write with MV
  status catch_all, confidence 40 — the send-gate already treats catch-all as
  risky-but-sendable). MV outage/no-credits: mark items `error`+retry, mirroring the
  send-gate's fail-closed posture ([policy.ts](src/lib/millionverifier/policy.ts)).
  Cost ≈ ≤6 MV credits/contact (~$0.004 worst case), 30-day MV cache applies.
- **site_scrape (apify, new, ours):** private actor `leadstart/site-contact-scraper`.
  Input `{targets:[{domain, firstName?, lastName?}], maxPagesPerDomain: 6,
  pageKeywords?: string[], unblockerKey?: string}`. Per domain: fetch
  `https://{domain}` first, then DISCOVER candidate pages from its nav/footer
  links matched against `pageKeywords` (defaults: contact, contact-us, about,
  about-us, team, our-team, meet-the-team, staff, people, leadership, management,
  company + common non-English equivalents — kontakt, équipe, equipo, über-uns,
  chi-siamo), fetched in priority order contact → team/leadership → about (the
  hardcoded path list survives only as the fallback when the homepage yields no
  parseable links). All with plain HTTP (undici) + stealth-ish headers; escalate to
  Playwright+stealth (playwright-extra + puppeteer-extra-plugin-stealth) only when
  HTML is empty/JS-shelled/blocked. Extract mailtos + email regex + phone regex
  (tel: links, contact-page proximity), socials; flag `personMatch` when a target
  name appears near an email. Output one record per domain:
  `{domain, emails[], phones[], socials{}, personEmails:[{email,nameMatched}], usedBrowser}`.
  **Why an Apify actor for our own code:** the pipeline's one mechanism is
  start-run→poll→ingest; a private actor slots into `PhaseProvider` unchanged, needs
  no new infra (Vercel can't run Chromium), bills raw compute (~$0.002–0.01/site,
  no per-lead events), and Apify datacenter/residential proxies are available if
  blocks demand them. Alternative (rejected for now): external worker on Fly/Railway —
  more infra, a second deploy target, a second secret path.
  Writes: `contacts.phone` (fill-only) from best phone; generic emails →
  `enrichment_data.enrichment.company_emails` (existing convention — NEVER into
  `contacts.email`); a `personEmails` name-matched hit MAY write `contacts.email`
  (provider `site_scrape`, then MV-verified by the existing pre-send gate).
- **vdrmota / bovi (apify, existing):** unchanged providers; vdrmota gains
  configurable `maximumLeadsEnrichmentRecords` (default drops 10 → 3) and stays
  available for the rare "directory dump" want. bovi is the hosted pattern-finder
  fallback (pay per found email; free-tier price unverified — pin on first run).

**Size routing (the panel's core):** two bands split at `size_threshold` (default
50 employees, editable): `small_method` (default `site_scrape` + `pattern_mv` both)
and `large_method` (default `pattern_mv` only), plus `unknown_method` (default
`pattern_mv`). Employee count source: `employee_count` captured in the domain phase
(new denormalized column on `enrichment_run_items`, backfilled from
`extra.company.employeeCount` at ingest); fallback to the contact's
`enrichment_data.enrichment.company.employeeCount`; else `unknown`.

---

## Schema (migration `supabase/migrations/00075_enrichment_waterfall_settings.sql`)

> Note: `00074` is TAKEN TWICE already (`00074_fix_password_reset_tokens_rls.sql` +
> `00074_create_linkedin_search_presets.sql`) — use `00075`, and don't "fix" the
> collision here. Purely additive + idempotent, applied only on explicit "go"
> (`node scripts/supabase-sql.mjs --file …`; local dev shares the PROD database).

```sql
SET search_path TO public;

-- Org-level enrichment/waterfall config. One JSONB blob, versioned by shape:
-- {
--   "waterfall_enabled": true,
--   "size_threshold": 50,
--   "small_method":   "scrape_plus_pattern",   -- scrape_plus_pattern|pattern_mv|site_scrape|vdrmota|bovi|off
--   "large_method":   "pattern_mv",
--   "unknown_method": "pattern_mv",
--   "vdrmota_max_leads": 3,
--   "accept_catch_all_guesses": false,
--   "scrape_max_pages": 4
-- }
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS enrichment_settings JSONB;

-- Per-item routing + size input (advancePhase stamps method; domain ingest stamps count)
ALTER TABLE enrichment_run_items
  ADD COLUMN IF NOT EXISTS waterfall_method TEXT,
  ADD COLUMN IF NOT EXISTS employee_count INT;

-- Config snapshot on the run (matches the existing actor-snapshot pattern so an
-- in-flight run never re-reads live settings)
ALTER TABLE enrichment_runs ADD COLUMN IF NOT EXISTS waterfall_config JSONB;
```

`email_provider` values gain `'pattern_mv'` and `'site_scrape'` — it's plain TEXT in
the DB (check constraint only exists in the TS union `EmailProviderId`; extend the
type in [src/types/app.ts](src/types/app.ts)).

---

## Work plan (each phase compiles + verifies standalone; LOCAL ONLY until owner says push)

> **STATUS (2026-08-24, follow-up session): Phases 0 + 1 are BUILT and verified
> locally (uncommitted).** Migration 00075 is APPLIED to the live DB (all 4
> columns confirmed). Owner decisions taken: size_threshold=50, catch-all OFF,
> Phase-3 hosting = private Apify actor, pattern_mv writes contacts.email = yes.
> Settings card round-trip verified against organizations.enrichment_settings;
> enrich-dialog estimate shows per-domain math with the configured lead cap.
> NOT yet verified live: a real domains-phase run filling contacts.phone +
> employee_count. Owner confirmed 2026-08-24: NO Starter upgrade — waiting on
> the Aug 28 free-tier reset. Run the ~$0.01 domains-only verification (2–3
> contacts) after Aug 28, or immediately if the upgrade happens first.
> The "settings page hangs on direct load" observation from this verification was
> investigated (2026-08-24 follow-up) and is NOT an app bug: it is an artifact of
> the embedded preview pane, which never composites frames when not displayed, so
> requestAnimationFrame never fires and Turbopack-dev hydration of deep
> Suspense-boundary routes parks forever on the loading skeleton. The same
> direct-URL load renders fine in real Chrome (verified). No app fix needed;
> when testing deep admin routes in the hidden preview pane, use client-side
> navigation (sidebar links) instead of full-document loads.

### Phase 0 — config plumbing (no behavior change) — ✅ DONE (2026-08-24)
1. Migration `00075` above (write file; apply only on explicit "go").
2. [src/types/app.ts](src/types/app.ts): `EnrichmentSettings` type + defaults const;
   `Organization.enrichment_settings`; extend `EmailProviderId`;
   `EnrichmentRunItem.waterfall_method/employee_count`; `EnrichmentRun.waterfall_config`.
3. [src/lib/apify/auth.ts](src/lib/apify/auth.ts): `loadEnrichmentSettings(admin, orgId)`
   → merge stored JSONB over defaults (missing keys = defaults; never throw).

### Phase 1 — Waterfall settings card + honest costs — ✅ DONE (2026-08-24, except live company-phone run)
1. New `src/app/(dashboard)/admin/settings/api/waterfall-settings-card.tsx`, rendered
   right after the Apify spend card in
   [settings/api/page.tsx](src/app/(dashboard)/admin/settings/api/page.tsx)
   (follow `apify-spend-card.tsx` — uncommitted in tree — as the co-located-card
   pattern). Controls: master toggle; size threshold (number); per-band method
   selects (small/large/unknown) — Phase 1 offers only the methods that exist
   (`vdrmota`, `bovi`, `off`; the rest appear as they ship); vdrmota lead cap (1–10);
   catch-all toggle (disabled until Phase 2, with hint). Save = PATCH new route
   `POST /api/admin/enrichment/settings` (owner-gated like the key saves) writing
   `organizations.enrichment_settings`.
2. [enrich/start/route.ts](src/app/api/admin/contacts/enrich/start/route.ts): load
   settings; snapshot to `enrichment_runs.waterfall_config`; `run_waterfall` respects
   `waterfall_enabled`; waterfall actor snapshot = configured method's actor (bovi or
   vdrmota) for apify methods.
3. [waterfall-vdrmota.ts](src/lib/apify/providers/waterfall-vdrmota.ts): `buildInput`
   reads `maximumLeadsEnrichmentRecords` from the run's `waterfall_config`
   (thread config into `PhaseProvider.buildInput` — add an optional second arg;
   only vdrmota uses it today).
4. Fix the lying estimates: [pricing.ts](src/lib/apify/pricing.ts) — waterfall
   estimate = per-DOMAIN `(leads_cap × lead_price_for_tier)`, and surface "free tier
   ≈ 20× higher" in the Contacts enrich dialog copy
   ([contacts/page.tsx](src/app/(dashboard)/admin/contacts/page.tsx) enrich dialog).
5. **Company-phone capture (cheap win, zero new spend):**
   [company-harvestapi.ts](src/lib/apify/providers/company-harvestapi.ts) also return
   `phone` (from `rec.phone.number`), `employeeCount`, HQ location in `extra.company`;
   domain-phase ingest in
   [run-apify-enrichment/route.ts](src/app/api/cron/run-apify-enrichment/route.ts)
   writes `contacts.phone` fill-only (`.is('phone', null)`) + stamps
   `enrichment_run_items.employee_count`.

### Phase 2 — pattern_mv direct method — ✅ BUILT (2026-08-24), live MV run pending a key

> **Status (2026-08-24):** built + type-checked + unit-tested (candidate generator,
> `scripts/test-pattern-mv.ts`, 9/9). New `src/lib/enrichment/pattern-mv.ts`
> (generator + `runPatternMv` worker pool); cron `run-apify-enrichment` gained the
> direct-method pathway (`runPatternMvBatch`), method-grouped routing
> (`startNextWaterfall`), per-item size-band seeding (`seedWaterfallItems`), and
> fail-closed MV suppression/alert parity. Defaults flipped to `pattern_mv`;
> settings card offers it + the catch-all toggle is live; the enrich-dialog
> estimate is method-aware (pattern ≈$0.004/contact vs vdrmota per-domain) —
> both verified in the preview, route round-trip verified against the DB.
> **Blocked for the live run:** the org has NO Million Verifier key saved (and
> none in env), so a real pattern_mv run can't execute yet — same class of block
> as Phase 1's Apify budget. Code handles no-key gracefully (marks items
> "MV key required", never crashes). To run live: save an MV key in Settings →
> Integrations, set the org's bands to pattern_mv, then enrich 3 email-less
> contacts that have a domain (~≤18 credits). The org's stored settings were left
> unchanged (still vdrmota) — the pattern_mv default applies to new orgs.
1. `src/lib/enrichment/pattern-mv.ts`: candidate generator (order above; skip
   candidates colliding with known-bad; lowercase; dedupe) + `runPatternMv(items)`
   using the MV client; returns `PhaseResult`-shaped output.
2. Cron: add the **direct-method pathway** — in the waterfall phase, if the next
   pending batch's `waterfall_method='pattern_mv'`, process inline (≤50 items/tick,
   time-budgeted like the Apify start budget), reusing `writeEmail(...,'pattern_mv')`
   and per-item cost stamping (MV credits × unit price). No Apify run row involved;
   `waterfall_apify_run_id` stays null.
3. advancePhase stamps `waterfall_method` per item from settings + `employee_count`
   band (this is where routing lives). Batch selection becomes method-grouped
   (`.eq('waterfall_method', m)` — process methods in a fixed order per tick).
4. Enable `pattern_mv` + `scrape_plus_pattern`(pattern-only until Phase 3) in the
   settings card; flip DEFAULTS to `pattern_mv` everywhere; catch-all toggle goes live.

### Phase 3 — site_scrape actor + provider

> **PROGRESS (2026-08-24): the ACTOR is built + its pure logic unit-tested.** Not
> yet deployed (blocked on Apify budget) and not yet wired into the pipeline.
> Built in `apify-actors/site-contact-scraper/`:
>   - `fetchPage.ts` — the 5-tier waterfall (undici → curl_cffi fingerprint →
>     curl_cffi+proxy → Playwright+stealth → managed unblocker), SSRF guard +
>     per-domain politeness + phrase-list block detection, all ported/adapted
>     from the saasassins engine; `fetchOutcome` per domain.
>   - `fingerprint_fetch.py` + `fingerprintFetch.ts` — the curl_cffi tier (+proxy).
>   - `unblocker.ts` — tier-5 client + 429 circuit breaker.
>   - `extract.ts` (emails/phones/socials/personMatch) + `discover.ts` (nav-link
>     discovery + multilingual keyword priority) — PURE, unit-tested green
>     (`test/`: 17 + 6). Block-detection does NOT reject on smallness; `accept()`
>     predicate threaded (email-or-name).
>   - `main.ts` (Apify entry) + `scrape.ts` (per-domain orchestration) + Dockerfile
>     (Node+Chromium base + python3/curl_cffi) + `.actor/` manifest + input schema.
>   - App `tsconfig.json` excludes `apify-actors` so the actor's own toolchain
>     doesn't pollute the app build (verified: no leakage).
> **PIPELINE WIRING DONE (2026-08-24) — Phase 3 is CODE-COMPLETE except deploy.**
> (i) ✅ `src/lib/apify/providers/waterfall-scrape.ts` PhaseProvider — buildInput
> dedupes by domain (one target/domain, representative name); parseItems joins by
> domain, re-derives per-contact name matches from the record's personEmails[],
> surfaces phone + company_emails in `extra`. Actor id is env-overridable
> (`SITE_SCRAPE_ACTOR_ID`, default `leadstart~site-contact-scraper`) so no code
> change is needed after `apify push`.
> (ii) ✅ Registered in providers/index.ts (`WATERFALL_BY_ACTOR`,
> `resolveWaterfallActor`) + cron `actorForMethod`.
> (iii) ✅ Cron two-stage: method groups are now DIRECT (`pattern_mv`), SCRAPE
> (`site_scrape` + `scrape_plus_pattern`), APIFY_SOLO (`vdrmota`,`bovi`);
> `startNextBatch` methodFilter is an array (`.in`); `startNextWaterfall` routes
> the scrape group to the scrape actor; `writeEmail` writes `contacts.phone`
> fill-only + `company_emails` on both hit AND miss, and `finishWaterfallMiss`
> hands a `scrape_plus_pattern` miss to stage-2 pattern_mv (flips
> waterfall_method → pattern_mv, status → pending). `waterfall_method` added to
> `ENRICH_ITEM_WORK_COLUMNS` + ItemRow; `isEmptyInput` recognizes `targets`.
> (iv) ✅ Settings card lists site_scrape + scrape_plus_pattern; enrich-dialog
> estimate has a `scrape` kind (≈$0.006/company compute) — verified live in the
> preview. pricing.ts: `estimateScrapeCost` + `SITE_SCRAPE_COST_USD`.
> All app tsc-clean; actor pure logic 23/23 green.
> **REMAINING: only deploy** — `apify push` (owner CLI login, needs Apify budget
> headroom → Aug 28), set `SITE_SCRAPE_ACTOR_ID` (+ optional
> `SITE_SCRAPE_UNBLOCKER_KEY`) in Vercel env, smoke-test 3 sites, then set an org
> band to site_scrape/scrape_plus_pattern to exercise end-to-end.

> **Design locked with the owner (2026-08-24, follow-up session).** Build for ANY
> ICP, not just small/local businesses — the scraper is intended to eventually be
> resold as a decision-maker-finding service for other companies' TAM/ICPs.
> (a) **Discovery-driven, broader page selection** — homepage first, then internal
> nav/footer links matched against the configurable `pageKeywords` input (broad
> multilingual defaults above; leadership/our-team/staff/people included — team
> pages are the personMatch fuel), priority contact → team/leadership → about,
> capped by `scrape_max_pages` (org default now **6**, was 4). Hardcoded paths
> only as the no-nav fallback.
> (b) **FIVE-tier escalation ladder — upgraded 2026-08-24 from the proven
> saasassins-scraper-engine (curl_cffi tier recovered 144/144 = 100% of a hard
> anti-bot set at ~250ms, $0).** The original 3-tier plan jumped undici →
> Playwright → unblocker and MISSED the highest-leverage cheap tier: a TLS/JA3 +
> HTTP-2 **fingerprint impersonation** fetch (no browser). Most small/mid sites
> gate on the client's TLS handshake fingerprint (Akamai, many WAFs), NOT on a JS
> challenge — Node's undici has a non-browser JA3 and gets blocked; `curl_cffi`
> reproduces a real Chrome fingerprint so the same plain GET sails through and the
> content is already in the static HTML. New ladder:
>   1. **undici direct** — plain HTTPS + Chrome UA, datacenter IP (~100ms, $0; unprotected sites)
>   2. **curl_cffi fingerprint** — Chrome TLS/JA3 + HTTP-2 impersonation, no browser (~250ms, $0; beats TLS/WAF gating — THE new tier, the reason for the high hit rate)
>   3. **curl_cffi + Apify residential proxy** — fingerprint + clean IP reputation (small proxy cost; beats IP-reputation blocks a datacenter IP fails)
>   4. **Playwright + stealth** (playwright-extra + puppeteer-extra-plugin-stealth, optionally via residential proxy) — only when the page is JS-RENDERED (seconds, compute)
>   5. **managed unblocker** (Scrapfly-class ASP+render_js, plain HTTP from inside the actor) — hard Cloudflare/DataDome only; key-optional (`unblockerKey` in input; absent → ladder stops at tier 4), fires ONLY on a tier-4 miss, with a consecutive-429 circuit breaker (disable for the run after ~6 sustained 429s = quota exhausted) mirroring the reference's ScrapFly breaker.
> Fingerprint (tiers 2–3) is network-layer; stealth (tier 4) is browser-layer —
> we now have BOTH (the original plan had only the browser layer). Each domain
> stamps `fetchOutcome: ok_http | ok_fingerprint | ok_fingerprint_proxy |
> ok_browser | ok_unblocker | blocked | empty | error` so each run measures its
> own tier distribution + block rate. Per-tier gating keeps the cost story intact
> — curl_cffi collapses the escalation rate to the expensive browser/paid tiers,
> so most "blocked" sites resolve at ~$0. Docker image note below (Python).
> (c) **Pre-run estimate band** — the Contacts enrich dialog gains a site_scrape
> estimate line (≈$0.002–0.01 × domains, "billed as compute"; unblocker requests
> cost extra), not just post-run `usageTotalUsd`.
> (d) Resale productization (whose Apify account, billing pass-through,
> multi-tenancy) is explicitly OUT of Phase 3 — running the private actor under
> the owner's account on clients' behalf covers v1.
> (e) **Block-detection + accept-predicate (adopt from the reference verbatim —
> both are battle-tested and one contradicts the original plan).**
>   - A 200 whose BODY is a challenge page is NOT success: match a
>     high-precision interstitial phrase list ("pardon our interruption", "just a
>     moment...", "verifying you are human", "attention required!", "enable
>     javascript and cookies to continue", "access to this page has been denied",
>     …) over the first ~4KB. Deliberately specific — a bare "cloudflare"/"captcha"
>     mention appears on legit pages.
>   - **DROP the original plan's "<500 chars text → escalate" rule.** The
>     reference explicitly warns it drops real leads: legit minimal company sites
>     / SoS pages are often tiny. Only treat truly-empty (<~120 chars) as a miss.
>   - **`accept(html, status)` predicate** threaded per fetch: for our use case,
>     accept = "page yields a mailto/email regex OR the target's name". A page
>     that loads clean but has no contact info then FALLS THROUGH to a browser
>     render (which may reveal JS-injected `mailto:`s) instead of being scored a
>     miss — a direct hit-rate win for email specifically. Keep the last usable
>     HTML and return it if every tier fails accept.
> (f) **SSRF guard + politeness (legal guardrail — the actor fetches arbitrary
> discovered nav-link URLs).** Block private/loopback IPs via DNS resolution
> before fetch; per-domain min 1.5s gap between request starts; per-domain
> cooldown once a domain refuses (403/429) at EVERY tier — escalate tiers on a
> block, never hammer. NEVER add login, CAPTCHA-solving, or evasion beyond
> fingerprint-correct polite fetching of public pages.

1. New repo folder `apify-actors/site-contact-scraper/`. **Custom Dockerfile
   (NOT the Dockerfile-less template) — the image needs BOTH Node and Python:**
   base `apify/actor-node-playwright-chrome`, then `apt-get python3` +
   `pip install curl_cffi==0.13.0` (small). Fetch waterfall = a generalized
   `fetchPage(url, {accept, staticOnly})` ported from the reference's
   [fetchPage.ts](../saasassins-scraper-engine/src/fetchPage.ts): tiers 1/4/5 pure
   Node, tiers 2/3 shell out to a bundled `fingerprint_fetch.py` via `execFile`
   (the reference's Node→Python shim drops in unchanged). `staticOnly:true` (skip
   the browser tiers) for the bulk/large-company sweeps. Deployed to the owner's
   Apify account as a PRIVATE actor (`apify push` — needs the owner's Apify CLI
   login once; document in activation). Pin build memory ≤1024MB to keep
   `actor-start-gb` tiny (curl_cffi tier needs no extra memory; only Playwright/
   unblocker tiers do). **Why the Apify actor is the right home:** curl_cffi needs
   a Python subprocess and Playwright needs headful Chromium — neither runs on
   Vercel/serverless, but both run in the actor's Docker container. This
   VALIDATES the private-actor choice (the reference explicitly notes it must run
   on a real box/VPS, not serverless). Reference engine saved at
   `C:\Users\dtucc\Downloads\saasassins-scraper-engine.zip`; see
   [[apify-fingerprint-fetch-engine]] memory.
2. `src/lib/apify/providers/waterfall-scrape.ts`: `PhaseProvider` for it (join by
   domain like vdrmota's parser); writes phone fill-only, `company_emails` to
   enrichment_data, name-matched personal email via `writeEmail(...,'site_scrape')`.
3. `scrape_plus_pattern` becomes real: scrape first, pattern_mv on the still-missing
   (stamp both stages in `waterfall_notes`).
4. Settings card lists it; per-run cost read from `usageTotalUsd` as usual.

### Phase 4 — polish — ✅ DONE (2026-08-24)
- ✅ Per-method run-banner counters: pattern_mv emits its own progress line; the
  apify waterfall harvest now sets `"<Method>: N found · M miss · K deferred"`
  (waterfallMethodLabel), surfaced by enrichment-run-banner.tsx.
- ✅ Spend-card note that the site-contact-scraper is compute-priced (per site),
  not per-lead (apify-spend-card.tsx).
- ✅ Retire-vdrmota-as-default: providers/index.ts comment updated (default method
  is pattern_mv; WATERFALL_ACTOR is legacy back-compat only).
- ✅ Bonus consistency fix: `enqueue-enrichment.ts` (the Prospecting→Contacts
  auto-enqueue path) now loads + snapshots the org's enrichment_settings + gates
  run_waterfall, same as contacts/enrich/start — previously it hardcoded the
  vdrmota actor and ignored org config.
- ✅ PROJECT_STATUS + this doc updated.

---

## Verification (per phase, dev preview `leadstart-dev` + `/app/api/dev/login`)

- **P0/P1:** `npx tsc --noEmit` (only files we touch — repo has 37 pre-existing
  errors elsewhere); settings card round-trips (save → reload → values persist in
  `organizations.enrichment_settings`); start route snapshots config; with
  `waterfall_enabled=false` a new run skips the phase (items `skipped`); estimate in
  the enrich dialog shows the per-domain math. Company-phone: run a domains-only
  enrich on 2–3 contacts (~$0.01) → `contacts.phone` filled, `employee_count` stamped.
- **P2 (no-network first):** unit-style script `scripts/test-pattern-mv.ts` for the
  candidate generator + result mapping (match the repo's script-test harness style);
  then a live 3-contact run — expect ~≤18 MV credits. Verify catch-all path writes
  nothing with the toggle off.
- **P3:** actor tested directly on Apify console against 3 known sites (one static,
  one JS-heavy, one with published phone) before wiring; then end-to-end on 5
  contacts; confirm `usedBrowser` only on the JS-heavy one.
- **Apify budget note:** the account was AT the $5 free-tier cap on 2026-08-24
  (cycle resets **Aug 28**). Owner confirmed 2026-08-24: NO Starter upgrade —
  waiting on the reset. Live Apify verification needs headroom; pattern_mv
  (Phase 2) needs NO Apify at all and can be verified even while capped.

## Cost model after (per contact needing an email, paid Apify tier)

| Path | Before (vdrmota) | After |
|---|---|---|
| Personal email | ~$0.07 paid / ~$1.00 free per COMPANY, non-targeted | pattern_mv ~$0.004 (MV credits) |
| Company phone/generic email | (discarded) | harvestapi phone: $0 extra; site_scrape ~$0.002–0.01/site compute |
| Large-company routing | same blunt crawl | pattern_mv only — no wasted scrape |

## Open decisions for the owner (ask before the relevant phase)
1. Default `size_threshold` — 50 employees proposed.
2. Accept-catch-all-guesses default — proposed OFF.
3. Apify plan: did the Starter upgrade happen, or waiting on the Aug-28 reset?
4. Phase 3 hosting confirm: private Apify actor (recommended) vs external worker.
5. May pattern_mv write to `contacts.email` immediately (proposed yes — the MV
   pre-send gate re-verifies anyway), or hold candidates in enrichment_data only?

## Repo state at handoff (2026-08-24, end of session)
Everything from the planning session is **committed and pushed** — the tree was clean
at handoff. Relevant commits on master: `0f1fe77`/`e9181a2` (progress-polling fix,
campaign contacts card, client backfill, RLS migration), `e953eae` (prospecting
live-review, prior runs, fit-to-width table), `20d91f2` (search rename/collapse),
`936686c` (failed-run cost accounting + Apify spend card in Settings), `29fbab1`
(search-name field, bookmark fill, non-sticky topbar), `46e54b4` (this plan).
All verified in the dev preview before pushing. Nothing from Phases 0–4 below has
been started.
