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
- We keep the actor's OWN add-ons OFF BY DEFAULT (`scrapeContacts:false`, `scrapePlaceDetailPage:false`, and `maximumLeadsEnrichmentRecords:0` unless the `linkedinLeads` lever opts in): we enrich ourselves, cheaper ([`baseInput` in maps-search.ts](../src/lib/apify/sourcing/maps-search.ts)). ⚠️ `maximumLeadsEnrichmentRecords` is a cap **PER PLACE**, not per run, so we always send ≤`MAPS_LEADS_PER_PLACE` (3); an uncapped value dumps whole chain rosters (the 2026-08-30 $14.17 incident). Full semantics in [`docs/APIFY_ACTOR_COSTS.md`](APIFY_ACTOR_COSTS.md).
- Flow: `maps-search` route → `maps_searches` row → `run-maps-searches` cron (multi-area fan-out, one actor run per structured area, merge/dedupe by `google_place_id`) → `importMapsPlaces` → `contacts` with `company_domain`, `company_phone`, `google_place_id`, **`email:null`** ([`import-maps-places.ts:73-105`](../src/lib/apify/import-maps-places.ts)).
- **Mail host stamped at import (free).** `importMapsPlaces` looks up each firm domain's MX records and stamps `enrichment_data.mail_host` = `{host, mx, checked_at}` ([`import-maps-places.ts:80`](../src/lib/apify/import-maps-places.ts), classifier [`mail-host.ts:40`](../src/lib/enrichment/mail-host.ts)): `microsoft365` · `google` · `gateway` (Proofpoint/Mimecast/…) · `godaddy` · `other` · `none` (no mail server). 8 s budget; a domain not answered in time is looked up again at enqueue. Why: the host predicts whether Million Verifier can confirm a guessed address. On 873 enriched WA law firms (2026-09-25), 44% of Microsoft 365 firms became TuBe-ready vs 29% Google, 22% gateways, 18% other hosts, 9% no MX, 0% GoDaddy.
- **Cost:** ~$0.004/place on our tier (~$4/1k; Free $0.005 → Business/GOLD $0.0021, verified). Optional add-on events (off by default): company-contacts $0.003/place, **business-leads $0.0075 per PERSON found** (pay-on-hit, but the `maximumLeadsEnrichmentRecords` cap is PER PLACE, so always send ≤3; the 2026-08-30 $14.17 incident was an uncapped 400/place dumping chain rosters), email-verify $0.004/decisive.

### 2b. LinkedIn sourcing
- Actor `harvestapi~linkedin-profile-search` ([`profile-search.ts:12`](../src/lib/apify/sourcing/profile-search.ts)). Live, **cookieless** LinkedIn scraping; searches by ICP filters (titles, locations, companies, headcount, industry, seniority) ([`profile-search.ts:28-47`](../src/lib/apify/sourcing/profile-search.ts)).
- Depth dial `profileScraperMode` ([`profile-search.ts:14-18`](../src/lib/apify/sourcing/profile-search.ts)): Short (search page only) / Full (opens each profile) / Full+email.
- Returns: `linkedin_url`, name, headline, location, current company, `company_domain`, email (full+email mode) ([`profile-search.ts:145-175`](../src/lib/apify/sourcing/profile-search.ts)). **No job title**: the search runs in Short mode and `linkedin-save` stores no title, so a LinkedIn lead's `contacts.title` comes from the enrichment **profiles** phase (§3). A title filter (Owner / President / CEO / Founder) is matched by LinkedIn as keywords, so "Vice President" passes it; the profile title is what tells them apart.
- Flow: `linkedin-search` route → `linkedin_searches` row → `run-linkedin-searches` cron → `linkedin-save` → `contacts` (deduped by `lower(linkedin_url)`/`lower(email)`) → **auto-enqueues enrichment** ([`linkedin-save/route.ts:93-99`](../src/app/api/admin/prospecting/linkedin-save/route.ts)).
- **Cost (verified):** search-page $0.10/25 results; full-profile $0.004; full+email $0.01.

---

## 3. The shared enrichment engine (`run-apify-enrichment`)

One state machine for BOTH veins. Phase order, `advancePhase` ([`route.ts:2962-3128`](../src/app/api/cron/run-apify-enrichment/route.ts)):

```
profiles → domains → naming → waterfall → activity → verify → complete
```

Each phase is gated by a per-run flag (`run_*`) AND by whether any items qualify;
if none qualify it falls straight through to the next phase. `run_profiles` and
`run_domains` are always true; the rest come from settings/add-ons
([`enqueue-enrichment.ts`](../src/lib/apify/enqueue-enrichment.ts), the run insert).
A run always starts at `phase:"profiles"`.

**Weak-email-host pool (2026-09-25).** A Maps firm whose email runs on a host where
guesses rarely verify (`gateway` / `godaddy` / `other` / `none`,
[`WEAK_MAIL_HOSTS`](../src/lib/enrichment/mail-host.ts); 17% became TuBe-ready vs 44% on
Microsoft 365 / Google) is **set aside instead of enriched** ([`pool.ts`](../src/lib/enrichment/pool.ts)):
- **Import** tags it `pooled-weak-host` and never attaches it to the import's campaign, even when one was picked ([`import-maps-places.ts:94`](../src/lib/apify/import-maps-places.ts)).
- **`enqueueEnrichment`** never enriches or queues a pooled contact ([`enqueue-enrichment.ts:166`](../src/lib/apify/enqueue-enrichment.ts)), and pools any Maps-style firm whose host was only resolved there (tag + detach from campaign, [`:220`](../src/lib/apify/enqueue-enrichment.ts), [`poolContacts :326`](../src/lib/apify/enqueue-enrichment.ts); lookup for unstamped contacts in `resolveMailHosts` [`:347`](../src/lib/apify/enqueue-enrichment.ts)). Microsoft 365, Google, an unclassified host (no domain / failed lookup: never pooled on a guess), every lead with a LinkedIn profile URL (its email comes from the profile) and every contact already tagged `pool-released` are enriched as normal. The drain cron (`drain-enrichment-queue`) runs the same `enqueueEnrichment`, so a queued firm follows the same rule.
- **Every campaign path refuses pooled contacts**: Contacts → Push to campaign, the campaign's Add-existing picker (`candidate-contacts`) and its enroll (`enroll-existing`), and the admin enroll route; each reports `skipped_pooled`. **Backstop:** `run-native-sequences` fails any enrollment whose contact is pooled ([`route.ts:1018`, `:1334`](../src/app/api/cron/run-native-sequences/route.ts)). A pooled contact also has no email, so nothing could send anyway.
- **Release** = Contacts → select the tagged contacts → **Enrich** (`contacts/enrich/start`), which swaps the tag for `pool-released` ([`route.ts:383`](../src/app/api/admin/contacts/enrich/start/route.ts)); or the tube-pipeline skill's enrich step when the brief says `weak_hosts: "enrich"`, which swaps the tag the same way and then calls `enqueueEnrichment` ([`enrich.mts:59-66`](../.claude/skills/tube-pipeline/scripts/enrich.mts)). From then on they flow like any lead: `enqueueEnrichment` never pools a `pool-released` contact again (`isPoolReleased`, [`pool.ts`](../src/lib/enrichment/pool.ts); test `scripts/test-enqueue-pool-release.ts`).

| Phase | Actor / method | Item qualifies when… | Produces | Cost (verified) |
|---|---|---|---|---|
| **profiles** | `harvestapi~linkedin-profile-scraper` (by URL) ([`profile-harvestapi.ts:4,118-123`](../src/lib/apify/providers/profile-harvestapi.ts)) — feeds `urls: [linkedin_url]`; each result is joined back by the URL it echoes (`originalQuery.url`), then id, then name ([`:125-158`](../src/lib/apify/providers/profile-harvestapi.ts)): a Short-mode lead's `/in/ACwAA…` id is never the id the actor returns | has `linkedin_url` | live profile + email + **job title**. The title is the person's current role at the contact's own company, else their first current role ([`pickCurrentTitle`, `profile-harvestapi.ts:82`](../src/lib/apify/providers/profile-harvestapi.ts)); current roles are `currentPosition[]` plus every `experience[]` entry ending "Present", title field `position`, because `currentPosition` holds only LinkedIn's first role, often a side job (10 of 65 in run `ac01fd98`). Written fill-only to `contacts.title` and the item's `title`, with or without an email; the headline, the title's company and `title_source` (`company_match` / `first_current`) go to `enrichment.profile` ([`writeProfileTitle`, `route.ts:2251`](../src/app/api/cron/run-apify-enrichment/route.ts)). Also the **company LinkedIn page**, which fills the item and contact when the search gave none and is what the domains phase turns into `company_domain`: the page on the role at the contact's own company; when that role has none (the actor gives a search link), no page at all, because any other role's page is another employer, whose domain the waterfall would then guess and mail (2 of 65 contacts in `ac01fd98` got a side job's domain this way before 2026-10-11); with no role at the contact's company, the first page listed ([`pickCompanyLinkedinUrl`, `profile-harvestapi.ts:98`](../src/lib/apify/providers/profile-harvestapi.ts); written at [`route.ts:2223`](../src/app/api/cron/run-apify-enrichment/route.ts)). Tests: `scripts/test-profile-title.ts`, `scripts/test-profile-company-url.ts` | $0.004/profile, **$0.01 with email** (mode used) |
| **domains** | `harvestapi~linkedin-company` ([`company-harvestapi.ts:4`](../src/lib/apify/providers/company-harvestapi.ts)) + inline web-lookup discovery for name-only items | has a company LinkedIn ref, OR name-only w/ discovery on | `company_domain` | $0.004/company |
| **naming** | decision-maker `enrichBusiness` ([`decision-maker/index.ts:68`](../src/lib/decision-maker/index.ts)). **L1 reads the site, then Claude Haiku names the most senior person** ([`layer1.ts:99`](../src/lib/decision-maker/layer1.ts)): the homepage, then up to 4 linked pages **requested together**, people pages first (about / team / owner / founder / our-story / who-we-are / leadership, then staff / management / why-us, then contact, careers last; a page linked with and without a `#fragment` is read once) ([`findContactPages`, `fetcher.ts:205-238`](../src/lib/decision-maker/fetcher.ts)). Whole pages up to 2 MB ([`fetcher.ts:24`](../src/lib/decision-maker/fetcher.ts)), tags of any length stripped ([`htmlToText`, `fetcher.ts:190`](../src/lib/decision-maker/fetcher.ts)). **Each page gets its own share of a 20,000-char prompt budget**; the homepage is trimmed first, down to 3,000 ([`buildPageText`, `layer1.ts:34,74`](../src/lib/decision-maker/layer1.ts)). **Page fetches get the first half of the per-business limit** (15 s of the naming phase's 30 s, [`layer1.ts:43,122`](../src/lib/decision-maker/layer1.ts); limit passed in at [`index.ts:76`](../src/lib/decision-maker/index.ts)); a page still loading then is dropped and Haiku runs on the rest, leaving Haiku + Perplexity the other half. Fetched one after another, the 5 pages could take 50 s and time the whole lookup out. Until 2026-10-11 the pages were joined homepage-first and cut at 12,000 chars, so a long homepage hid the about/team pages. Pages are requested as desktop Chrome (full UA + Accept / Accept-Language, [`fetcher.ts:12`](../src/lib/decision-maker/fetcher.ts)). **L2 web-search = Perplexity Sonar ONLY** (no Claude fallback; skipped without a Perplexity key) ([`layer2.ts`](../src/lib/decision-maker/layer2.ts)). Test: `scripts/test-decision-maker-layer1.ts` | name-less, company-named, no email ([`route.ts:3022-3030`](../src/app/api/cron/run-apify-enrichment/route.ts)) | owner name + title | Perplexity ~$0.015/business |
| **waterfall** | size-band method: `site_scrape` / `scrape_plus_pattern` / `pattern_mv` / `bovi` ([`methodForItem`, `waterfall-routing.ts:26-43`](../src/lib/enrichment/waterfall-routing.ts)); name-less → forced `site_scrape`; a named lead opted into the company-inbox fallback whose band is `pattern_mv` → `scrape_plus_pattern` (below) | has a domain | generic + personal email | site_scrape ~$0.003 per site (compute); pattern_mv ≈ MV credits |
| **activity** | `harvestapi~linkedin-profile-posts` ([`activity-harvestapi.ts:7`](../src/lib/apify/providers/activity-harvestapi.ts)) | has `linkedin_url` ([`route.ts:3073-3078`](../src/app/api/cron/run-apify-enrichment/route.ts)) | posting-recency (last-posted date + in-30d flag) | $0.002/profile (samples 1 post only; $0.001 if none) |
| **verify** | Million Verifier | has an email | verified status | ~$0.0037/decisive; catch-all/unknown/error **free** ([`pattern-mv.ts:68-72`](../src/lib/enrichment/pattern-mv.ts)); fresh-cache hits (<30d — including `pattern_mv`'s own verdict) reuse the result with no call (§4) |
| **complete** | — | — | finalize outcome ledger | — |

### Which phases actually fire, per vein (the auto-routing)
Because phases self-skip when no item qualifies, the lead's DATA decides the path:

- **LinkedIn lead** (has `linkedin_url`): **profiles** (primary email source and the job title — scrapes the profile by URL), domains (company domain; when it ends, a profile email at another employer is set aside, below), waterfall (**fallback** for profiles that returned no usable email), activity (post recency), verify.
- **Maps lead** (name-less business, no `linkedin_url`): profiles → **skips** (no URL); **domains** → web-lookup discovery (name → domain); **naming** → owner-name discovery (if the add-on is on); **waterfall** → `site_scrape` (generic info@) + `pattern_mv` for items naming just named; activity → **skips** (no URL); verify.

**Profile emails at another employer (2026-10-11).** The profile scraper's email
search often returns the person's address at the company LinkedIn lists first,
which is often a side job: in run `ac01fd98` (65 cleaning-firm owners) 6 of the 33
profile emails were at one (a realty brokerage, a coffee franchise twice, an
inspection-report firm…), every one Million Verifier "ok" or catch-all, so the send
gate would have mailed them. So when the domains phase ends (every company domain is
known by then), `demoteOtherEmployerEmails` ([`route.ts:2291`](../src/app/api/cron/run-apify-enrichment/route.ts),
called at [`route.ts:3005`](../src/app/api/cron/run-apify-enrichment/route.ts))
checks every email this run's profiles phase wrote against the contact's company
domain ([`isOtherEmployerEmail`](../src/lib/enrichment/other-employer-email.ts)).
One on another business domain (not the company's, not a subdomain either way) is
moved off `contacts.email` into `enrichment.other_employer_email` with its original
provenance; the item becomes `not_found` with both domains in its note, so the
waterfall, seeded next, looks for an address at the company's own domain. Kept: a
free mailbox (a built-in list of personal providers, or the actor's own per-address
`free` flag, stored as `enrichment.profile.email_free`), a contact with no company
domain (can't be judged), and an address the contact no longer holds. Run without
the waterfall (`run_waterfall` off), a set-aside contact simply ends with no email.
Checked on the same run, the simpler rule "the first listed role must be the
contact's company" also rejected 2 correct emails; comparing domains rejected only
the 6. Out of time → the run stays in `domains` and the next tick finishes the pass.
Test: `scripts/test-other-employer-email.ts`.

**Two `pattern_mv` guards (2026-09-25), both in `runPatternMvBatch`:**
- **No mail server → no guessing.** When the item's domain has no MX record (or doesn't exist), every guess would come back `invalid`, which MV charges for, so the item ends `not_found` ("domain has no mail server") with no MV call ([`route.ts:874`](../src/app/api/cron/run-apify-enrichment/route.ts)). Only a definitive `none` skips; a failed lookup still guesses. Checked on 688 found emails: none was a guess on such a domain (those firms' real addresses live on another domain).
- **Catch-all → the owner's published address first.** On a catch-all outcome, if an address the firm publishes on its own site (our site scrape's `company_emails`, or Scrap.io's crawl in `source_row.scrapio_emails`) is on the firm's domain and identifies the named owner, it replaces the guess, free, before any Findymail recovery ([`route.ts:968`](../src/app/api/cron/run-apify-enrichment/route.ts), matcher [`published-email.ts`](../src/lib/enrichment/published-email.ts)). Written as provider **`site_published`**, confidence 70. If it IS the guess, the guess's MV verdict is kept; otherwise the verify phase checks it (catch-all answers are free).

**Catch-all recovery (Findymail, add-on — migration 00099).** When a run opts into
"validate catch-all emails" (per-search toggle OR the org
`EnrichmentSettings.validate_catch_all` default) AND a Findymail key is set, the
waterfall's `pattern_mv` DEFERS its catch-all outcomes (a confidence-40 guess, or a
catch-all miss — flagged by `PatternMvOutcome.sawCatchAll`) instead of writing them,
then hands each to **Findymail's finder** (`app.findymail.com/api/search/name`,
name+domain) to recover a genuinely deliverable address on catch-all domains
pattern_mv is structurally blind to. A hit writes `contacts.email` clean (provider
`findymail`, conf 75); a miss OR any Findymail error falls back to the original
pattern_mv outcome, so no lead is lost. Findymail is **pay-on-hit** and NOT a send
gate — a definitive error just stops calling for the rest of the batch, never holds
the run. Code: `runPatternMvBatch` in [`run-apify-enrichment/route.ts`](../src/app/api/cron/run-apify-enrichment/route.ts),
client [`src/lib/findymail/client.ts`](../src/lib/findymail/client.ts).

**Company-inbox fallback for NAMED leads (add-on `company_inbox_fallback`, default
off, 2026-10-11).** By default a lead with a person's name keeps the person-only
contract: when no personal email is found, the scraped generic inbox stays in
`contacts.company_email` only, and since the native sender (`run-native-sequences`)
mails `contacts.email` only, that lead can't be sent to. Measured on the SaaSassins
cleaning test (run `ac01fd98`, 65 named owners): 27 got no personal email, 6 of them
had an inbox captured but unsendable, and the 10 in the 50+ band never had their site
scraped at all (`large_method = pattern_mv`). With the add-on:
- **Routing.** An opted-in named lead whose size band is `pattern_mv` (it only
  guesses, so no inbox is ever captured) gets `scrape_plus_pattern` instead: site
  scrape first, its misses still go on to pattern_mv ([`waterfall-routing.ts:41`](../src/lib/enrichment/waterfall-routing.ts),
  applied in `seedWaterfallItems` [`route.ts:1841`](../src/app/api/cron/run-apify-enrichment/route.ts)
  and the Enrich route's seed-at-insert). `bovi` and `off` bands are left as
  configured; the org's settings are not changed. Cost: ~$0.003 per company scraped.
- **Promotion.** When the waterfall has nothing left pending, before activity and
  verify are seeded, `applyCompanyInboxFallback` ([`route.ts:1959`](../src/app/api/cron/run-apify-enrichment/route.ts),
  called at [`route.ts:3052`](../src/app/api/cron/run-apify-enrichment/route.ts))
  takes every opted-in contact whose waterfall item ended with no address
  (`not_found`, or `error` after its retries) and that has `contacts.company_email`,
  and fills `contacts.email` with it, fill-only, with the same provenance as the
  name-less backfill: `enrichment.email = {provider: site_scrape, kind:
  company_generic, confidence: 30, via: "company_inbox_fallback"}`
  ([`company-inbox.ts`](../src/lib/enrichment/company-inbox.ts)). One pass at the
  waterfall's end covers every terminal miss (site_scrape, pattern_mv including a
  `scrape_plus_pattern` handoff, bovi, no MX, no MV key, the retry cap). The item
  becomes `found` with the address and keeps why the personal search missed in its
  note, so the verify phase gives it a Million Verifier verdict. It stays tiered
  **company** (`email-tier.ts`), so TuBe's handoff still excludes it. An inbox that
  is already another contact's email (two people at one firm) leaves this contact
  without one (item `skipped`, noted). Runs out of time → stays in the waterfall
  phase and the next tick finishes (idempotent).
- **Who gets it.** Stored on the run's `waterfall_config` snapshot as
  `company_inbox_fallback`: `"opted_in"` from `enqueueEnrichment` when any contact's
  `enrichment_data.addons` stamp opted in (then only those contacts get it, and the
  extra scrape), `"all"` from Contacts → Enrich with the box ticked (every selected
  contact). Absent = off, which is every run before the add-on and the TuBe/law
  pipeline. Chosen per search (LinkedIn panel, Maps DIY panel; both search routes
  store it on `query.addons`, and imports stamp it on each contact) or in the
  Contacts → Enrich dialog. Test: `scripts/test-company-inbox-fallback.ts` (drives
  the real cron tick, `enqueueEnrichment` and the Enrich route).

---

## 4. Where each email actually comes from (the part that was gotten wrong)

- **LinkedIn personal email:** PRIMARY = the **profiles phase** (`linkedin-profile-scraper`, by URL) ([`profile-harvestapi.ts:160,186-194`](../src/lib/apify/providers/profile-harvestapi.ts)). FALLBACK only = `pattern_mv`/`site_scrape` in the waterfall when the profile scrape returned no email, or returned one at another employer, which is set aside (§3, "Profile emails at another employer").
- **Maps generic email (info@):** the **`site_scrape`** actor (`site-contact-scraper`) reads the company website; for a name-less lead the generic inbox is backfilled onto `contacts.email` (`finishWaterfallMiss`, [`run-apify-enrichment/route.ts:2404-2441`](../src/app/api/cron/run-apify-enrichment/route.ts)). For a named lead it stays in `contacts.company_email` (filled by `writeEmail` from the scrape's extras, the only writer of that column).
- **Named lead's company inbox (add-on `company_inbox_fallback`):** when the waterfall ends with no personal email, `contacts.company_email` is promoted onto `contacts.email` with the same `company_generic` provenance (confidence 30, tier company), then verified like any scraped inbox. Off by default; §3 has the rules.
- **Maps personal email:** **naming** finds the owner → **`pattern_mv`** guesses `first.last@domain` and Million Verifier confirms the deliverable one ([`pattern-mv.ts:40-66,106-166`](../src/lib/enrichment/pattern-mv.ts)). That MV verdict is a genuine, paid result, so it is **stamped straight onto the contact's verification cache** (`email_verified_at`, built via `decideFromResult`) in the SAME statement that fills `contacts.email` ([`writeEmail` in run-apify-enrichment/route.ts](../src/app/api/cron/run-apify-enrichment/route.ts)).
- **One verdict, one 30-day cache — no double-verify.** `pattern_mv` (in the waterfall), the end-of-run **verify** phase, and the **pre-send gate** all read the same cache through `decideFromCached`/`isFresh` (`VERIFICATION_TTL_DAYS = 30`, [`policy.ts:28`](../src/lib/millionverifier/policy.ts)). Because `pattern_mv` now caches its verdict, the verify phase finds it fresh and short-circuits with **no second MV call** (a Maps lead used to be verified twice in one run — the pattern pass, then again at the end). Only email sources that are NOT themselves MV results — `site_scrape` generic inboxes, LinkedIn-profile emails, Findymail catch-all recoveries — still reach the verify phase unverified and earn their first MV verdict there.
- **Million Verifier is verify-only, never a finder.** It also runs as the pre-send gate in `run-native-sequences`.
- **Published owner address on a catch-all domain (`site_published`, or a `site_scrape` / `decision_maker` address).** MV can only answer `catch_all` there, but an address the firm publishes is a real mailbox (a guess may not be). The TuBe upload accepts it when it is on the firm's domain and identifies the named owner (`tubeEmailStatus`, [`handoff.ts:248`](../src/lib/tube/handoff.ts)); the dialog counts these separately so their bounces can be watched. The send gate already sends catch-all addresses, flagged risky.
- **Findymail catch-all recovery (add-on):** the ONE finder that returns deliverable emails on catch-all domains (its own catch-all recovery classifies deliverable vs risky and returns only the deliverable ones). Fed name+domain from the deferred pattern_mv catch-all items; pay-on-hit, so misses/risky catch-alls cost nothing. See §5's routing note.

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
| `harvestapi~linkedin-profile-posts` | enrich: activity | per post/reaction/comment | $0.002/profile (1 post sampled; ·$0.001 no-result) |
| decision-maker (Anthropic/Perplexity) | enrich: naming | per business (LLM tokens) | ~$0.015 Perplexity (L2 is Perplexity-only since 2026-08-28) |
| `site-contact-scraper` (`indispensable_nonagon`) | enrich: waterfall (site_scrape) | per site (compute) | ~$0.003 |
| pattern_mv + Million Verifier | enrich: waterfall / verify | per decisive verification | ~$0.0037 (catch-all/unknown free) |
| Findymail (`app.findymail.com`) | enrich: waterfall catch-all recovery (add-on) | per verified email FOUND | ~$0.049/hit ($49/1k entry; $249/15k ≈ $0.017); misses/risky catch-alls free |
| DNS MX lookup (`mail-host.ts`) | import + enqueue: mail-host stamp / weak-host pool; pattern_mv no-MX skip | — | free (node DNS, DNS-over-HTTPS fallback) |
| Published owner address (`published-email.ts`) | enrich: pattern_mv catch-all pass | — | free (reads addresses already scraped) |

---

## 7. Standing rule

- Answer flow questions from this doc + the cited code, never from memory.
- Any change to a sourcing actor, an enrichment phase/provider, or the phase state
  machine updates this doc in the same change.
- The in-app **Enrichment Flow Map** (Admin → Workflows,
  [`src/components/workflows/enrichment-flow-map.data.ts`](../src/components/workflows/enrichment-flow-map.data.ts))
  is the visual twin of this doc and MUST move with it: costs + default behaviour
  auto-sync from the live constants, actor IDs are guarded by
  `scripts/test-flow-map-sync.ts` (run it after any flow change), and the branch
  structure is hand-drawn there — re-draw it when the topology changes.
- If a claim here can't be traced to the cited line, treat it as stale and re-verify.
