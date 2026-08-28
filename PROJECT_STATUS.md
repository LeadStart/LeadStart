# LeadStart — Project Status

> Last updated: 2026-08-27

## Current State: Deployed to Production, native-Gmail-only

Live at https://leadstart-ebon.vercel.app (LeadStart Vercel account, auto-deploys on push to `master`). Real Supabase project (`exedxjrifprqgftyuroc`). Real auth, real data. No mock-mode anywhere — local dev points at the same Supabase.

**Email channel:** native Gmail API (only). Salesforge and Warmforge were removed entirely — schema, code, types, settings, env, docs. The native channel (`src/lib/gmail/` + `src/lib/native/`) handles sequences, sending, and replies. No remaining Salesforge/Warmforge surface.

**LinkedIn channel:** code-complete via Unipile; not yet activated (gated on migrations + Unipile config).

**Instantly channel (re-added 2026-07-19):** code-complete parallel email channel alongside native Gmail; **not live yet** — gated on applying migration `00065`, adding the API key in Settings, deploying, and registering the reply webhook. Native Gmail is unchanged. Full activation checklist + design decisions in [`RESUME-INSTANTLY-CHANNEL.md`](RESUME-INSTANTLY-CHANNEL.md).

---

## Current initiative: DNS registrar + Google Workspace provisioning (BUILT 2026-08-27 — local, unpushed; migration 00096 APPLIED to prod; live activation = WP7)

The two "API integrations" for Gmail-tier growth: buy/track a sending domain + write its DNS
(registrar automation, plan Phase 2 — finished), and auto-create its Google Workspace inboxes
(Phase 3 — new). Code-complete and build/unit-verified; only Daniel's Google/registrar setup + a
live provision run remain.

- **DNS finish:** true-upsert record diff (TXT by semantic slot, MX/A exclusive) so Porkbun no
  longer dup's on retry and Spaceship read-merge-writes; Spaceship price-parse + contacts + async-op
  fixes (still pending one `scripts/probe-spaceship.ts` run to pin shapes); a split **Porkbun |
  Spaceship** selector + quote/suggest endpoints + a provision card on Admin → Mailboxes; the
  orphaned `/provision` is now reachable and its `dns_written:false` case recoverable.
- **Workspace provisioning:** shared DWD auth substrate (`src/lib/google/auth.ts`, scope-aware
  cache) + Directory/SiteVerification/Licensing clients + an idempotent step machine
  (`src/lib/deliverability/provisioning*.ts`) + routes + a 10-min `advance-domain-provisioning`
  cron. Buy/track → add domain → verify (TXT) → create 1–3 users (one-time passwords, never stored)
  → mailboxes (`domain_id` set) → DKIM detect → flips the domain to warming.
- **Also fixed:** the mailbox POST never set `native_mailboxes.domain_id` (a latent 00081 bug making
  hand-added mailboxes invisible to the lifecycle machinery); migration 00096 re-backfills existing rows.

**Verified:** `npm run build` clean (9 new routes registered); tsc 0 new errors; unit — google-auth
23/23, registrar 84/84, provisioning 48/48, lifecycle 88/88. No live Google/registrar calls yet.

**Activation (WP7):** migration `00096` applied 2026-08-27. Remaining: Porkbun (+ Spaceship) keys +
monthly spend cap + 6 DWD scopes + 3 Google Cloud APIs + `google_admin_email` (checklist in
[`docs/plans/deliverability-infrastructure-plan.md`](docs/plans/deliverability-infrastructure-plan.md)
§6 + [`docs/native-email-runbook.md`](docs/native-email-runbook.md) §2a); then a zero-spend "track an
owned domain" e2e, then the first live buy on explicit go-ahead. Full session record in HANDOFF.md.

---

## Current initiative: Contact-list ↔ campaign variable alignment (SHIPPED 2026-08-27 — migration 00092 applied, deployed)

Instantly.ai-style alignment of CSV/CRM columns to a campaign's merge variables, with one persisted source of truth and a fail-safe send.

- **Source of truth (Phase 1):** a persisted per-campaign variable registry (`campaigns.variables` JSONB, migration `00092`) reconciled from copy tokens (all A/B variants + both condition branches) ∪ mapped list columns. Registry = schema; `contacts.custom_fields` = values; `campaign_enrollments` = who receives. Engine in [`src/lib/native/tokens.ts`](src/lib/native/tokens.ts) (`reconcileCampaignVariables`, `splitToken`) + [`src/lib/flow/graph.ts`](src/lib/flow/graph.ts) (`allEmailTemplates`).
- **Columns drive variables (Phase 1):** every CSV column is mappable — an unmatched column defaults to a NEW `custom:<Header>` variable (never silently dropped), with a "＋ New variable" inline namer in `native-import-panel.tsx`.
- **Fail-safe send (Phase 1):** `{{token|default}}` inline fallbacks; the live sender passes a blank fallback so a send NEVER emits a raw `{{token}}` (blanks instead). Preview keeps its leave-untouched / sample behavior. 45 unit tests in `scripts/test-campaign-variables.ts`.
- **Pull CRM contacts (Phase 2):** `CrmPullPanel` on the Leads tab — search/tag-select the client's contacts, coverage validation against the registry, enroll via `POST /api/campaigns/[id]/enroll-existing` (assigns `campaign_id` + upserts `campaign_enrollments`); search via `candidate-contacts`.
- **Authoring picker + importer de-drift (Phase 3):** the flow-editor "Insert:" chips are clickable, insert `{{token}}` at the cursor, and are populated from the registry; the admin global importer (`admin/contacts/import-dialog.tsx`) now shares the parser/normalizer/stage-list with the campaign importer (`src/lib/csv/parse-contacts.ts`).
- **Create-flow relaxation + launch readiness:** a campaign is created as a **draft from just a name** (client / mailboxes / a complete sequence all optional). [`src/lib/campaigns/launch-readiness.ts`](src/lib/campaigns/launch-readiness.ts) computes hard blockers (client assigned, a connected sending mailbox, a first email with subject + body) + soft warnings (no contacts yet), shown on the campaign detail page and gating **both** the Launch button and the activate endpoint. Contacts can be imported into a draft.

**Verified:** migration `00092` applied to prod; create + import registry writes, CRM enroll (`campaign_id` + enrollment), and the readiness gate all e2e-verified on live + throwaway data; `tsc` clean; unit tests — campaign-variables 45/45, launch-readiness 14/14, plus existing suites green.

---

## Current email channel: native Gmail API (live)

**Status:** the sole email channel. Sending, warmup ramp, and reply ingest all run through LeadStart's own Gmail-API code (`src/lib/gmail/` + `src/lib/native/`).

**What it does:**

- **Sending** via the `run-native-sequences` cron, which dispatches sequence steps under the per-mailbox warmup ramp in `src/lib/gmail/ramp.ts` (ramps daily send volume up gradually per mailbox rather than blasting at full capacity on day one).
- **Reply ingest** via the `poll-native-replies` cron, which pulls inbound Gmail messages and hands them to the shared reply pipeline for classification + hot-lead notification.
- **Contact import** via client self-service CSV upload into native campaigns (per-campaign token mapping through `/api/campaigns/[id]/client-import`).
- **Inbox health + seed placement** (migrations `00061`, `00067`, `00068`): hourly per-mailbox score from DNS/blacklist/bounce/reply signals plus the one *direct* measurement — a placement test that probes seed inboxes we control and reads back Inbox/Promotions/Spam + receiver-side SPF/DKIM/DMARC. Seed panel + per-mailbox tests live on **Admin → Mailboxes**; the `run-placement-tests` cron finalizes open tests and re-probes every active mailbox weekly. **Activation (2026-08-22 build):** migration `00068` applied 2026-08-22; push to deploy, then click **Use sending mailboxes as seeds** on the Mailboxes page and run a neutral + a campaign-copy probe per mailbox. Setup + interpretation in [`docs/native-email-runbook.md`](docs/native-email-runbook.md) §4.
- **Pre-send email verification (Million Verifier)** (migration `00069`, code-complete — **not live yet**): closes the #1 evidence-backed deliverability gap. Every recipient is verified *just before its first send* inside `run-native-sequences`; results cache on the contact for 30 days. `ok` sends; `catch_all`/`unknown` send flagged risky; `invalid`/`disposable` are skipped; a verifier outage / no credits **holds** new unverified sends (fail-closed) and alerts the owner. Key + credit balance on **Admin → Integrations → Email verification**; no key = gate disarmed (sends unverified). **Activation:** (1) apply migration `00069` in the Supabase SQL editor; (2) push to deploy; (3) save the Million Verifier key in Settings and click **Test connection**; (4) watch the first `run-native-sequences` ticks (`verification[].mode === "armed"`). Setup + policy + credit/outage handling in [`docs/native-email-runbook.md`](docs/native-email-runbook.md) §5.

---

## Current initiative: Configurable enrichment waterfall (Phases 0–4 CODE-COMPLETE 2026-08-24; live activation gated on Apify budget + MV key)

Replace the vdrmota-by-default second-pass email waterfall with an org-configurable,
per-company-size routed system: a Waterfall settings card (Settings → Integrations),
a pattern-permutation + Million Verifier email finder (~$0.004/contact vs vdrmota's
~$1.00/company on free tier — its one real run charged $3.96 and filled 0 fields),
our own 5-tier anti-bot site scraper for company-level phone/generic/personal email,
and company-phone/employeeCount capture from the harvestapi company actor.

**Shipped to prod (Phases 0–1, commits `98f5b83`/`5c4830e`):** migration `00075`
(applied to the live DB), `EnrichmentSettings` types + loader, the settings card +
`GET/POST /api/admin/enrichment/settings`, config snapshot + gating, configurable
vdrmota lead cap (10 → 3), honest per-domain cost estimates, and company
phone/employeeCount/HQ capture in the domains phase.

**Built locally, committed, NOT pushed (Phases 2–4, commit `10a53e7`):**
- **Phase 2 — pattern_mv:** `src/lib/enrichment/pattern-mv.ts` (permutation generator
  + Million Verifier verify loop, unit-tested), the cron direct-method pathway +
  per-item size-band routing + fail-closed MV parity, defaults flipped to
  pattern_mv, catch-all toggle live, method-aware dialog estimate.
- **Phase 3 — site_scrape:** the private Apify actor in
  `apify-actors/site-contact-scraper/` (5-tier waterfall undici → curl_cffi TLS
  fingerprint → +residential proxy → Playwright+stealth → managed unblocker, ported
  from the proven saasassins engine; discovery-driven crawl + extraction,
  unit-tested 23/23), the `waterfall-scrape.ts` provider + registry, the cron
  two-stage `scrape_plus_pattern`, and the scrape cost estimate.
- **Phase 4 — polish:** per-method run-banner counters, spend-card compute note,
  `enqueue-enrichment` now snapshots org settings too, retire-vdrmota-as-default
  comment, this status update.
- **vdrmota FULLY removed (2026-08-24, owner call):** superseding the earlier
  "keep as an option" decision. Deleted the provider + actor id + registry entry
  + routing + the `vdrmota` method/`EmailProviderId` union members + the
  `vdrmota_max_leads` setting + the settings-card option/lead-cap field + the
  prospecting-panel labels (now "pattern + verify"). Stored org settings migrated
  off vdrmota (coerced to pattern_mv). bovi stays as the opt-in Apify fallback.
  Historical vdrmota spend still shows in the Apify spend card (real billing data).

**site_scrape actor DEPLOYED + VERIFIED (2026-08-25).** Pushed as
`indispensable_nonagon/site-contact-scraper` **build 0.1.3**. The initial smoke test
exposed extraction bugs (date/year-range strings written as phones, role inboxes
mislabeled personal, off-domain page-noise leaks) — all fixed in the actor and
re-verified live: gnu.org's 7 fake phones → 0, role inboxes → companyEmails,
leaks gone. Actor-id wired in code (env-overridable), plus an app-side `pickBestPhone`
(write the +CC/≥10-digit number, not `phones[0]` noise) and an `isPlausibleContactPhone`
write-guard. Provider e2e on real data (James Hill @ apify.com → writes
`james.hill@apify.com` + `+17183565168`, 7/7). Deploy trap that cost 2 builds: `apify
push` from a `.claude/worktrees/*` checkout ships STALE source — push from the primary
repo (`apify-actors/site-contact-scraper`) or commit first.

**Remaining live checks (external-dependency gated):** Phase 1 company-phone fill via a
real domains-phase run, and a Phase 2 pattern_mv live run (MV key is present). Full
plan, evidence, schema, phased work plan + decision history:
[`RESUME-WATERFALL-SETTINGS.md`](RESUME-WATERFALL-SETTINGS.md).

## Current initiative: Google Maps prospecting vein (SHIPPED 2026-08-25 — code-complete, browser-verified, full-pipeline e2e-verified, pushed to master)

The second prospecting vein alongside LinkedIn — "no stone unturned." Google Maps
surfaces SMBs with no LinkedIn presence; their leads are company inboxes/phones
(at that size the owner reads info@), upgraded to an owner's personal email via the
new naming add-on. Source = Apify `compass~google-maps-extractor` (~$4/1k places;
Scrap.io subscription canceled, its Business-tab UI retired). Monetization model
(owner call): **outcome-tiered per lead** (record $0.05 → +generic email $0.10 →
+owner name $0.20 → +verified personal email $0.30), mid-market; this build lays the
**delivered-outcome ledger** the future self-serve billing prices against.

**Built locally, NOT pushed. Migrations `00078`/`00079`/`00080` APPLIED to the live DB
2026-08-25.**
- **Phase 0 — probe:** pinned the compass actor's charge events (`place-scraped`
  tiered, `filter-applied`, …), the `website` enum, and output fields (live run).
- **Phase 1 — domain-only leads become first-class:** name-aware waterfall routing
  extracted to `src/lib/enrichment/waterfall-routing.ts` (name-less items → site_scrape,
  never pattern_mv/bovi); `wantWaterfallOnly` eligibility in `enqueue-enrichment.ts` +
  `contacts/enrich/start`; `pickPersonEmail` accepts a name-less on-site person email
  (conf 50); **generic-inbox backfill** — a scraped company inbox fills `contacts.email`
  for name-less leads so the native sender can mail them (documented 00076 exception).
  Unit-tested (`scripts/test-waterfall-routing.ts`, 19/19).
- **Phase 2 — Maps vein core (migration 00078):** `maps_searches` table (linkedin_searches
  twin), `run-maps-searches` cron (start→poll→ingest, lease, auto-import+enrich),
  `src/lib/apify/sourcing/maps-search.ts` + `import-maps-places.ts` (dedup by
  `contacts.google_place_id`), API routes `maps-search`/`maps-searches`/`[id]`/`maps-save`,
  cron registered in vercel.json. Cost-minimal input (no filter events; closed places
  dropped client-side). **Live-verified:** sourced 8 med spas → imported with
  domain/phone/place-id → re-import deduped to 0.
- **Phase 3 — owner-name "naming" phase (migration 00079):** new opt-in enrichment phase
  domains → **naming** → waterfall; `runNamingBatch` runs the existing decision-maker
  orchestrator (`enrichBusiness` Layer 1/2) per name-less item, writes first/last/title →
  item routes to pattern_mv → MV-verified personal email. Fail-closed with no Anthropic
  key. `EnrichmentAddons.naming`, `run_naming`, `EmailProviderId 'decision_maker'`.
- **Phase 4 — panel + presets (migration 00080):** self-contained `MapsSearchPanel`
  (niche packs, location, filters, add-ons, presets, live estimate, streaming results,
  import), swapped into the Prospecting "Business (Google Maps)" tab (dead Scrap.io UI
  removed); `maps_search_presets` sibling table with a **global/system tier + slug** the
  future landing pages resolve; `maps-search-presets` routes.
- **Phase 5 — delivered-outcome ledger:** `src/lib/enrichment/outcomes.ts` classifies each
  contact by tier at run completion → `enrichment_runs.outcome_counts` +
  `maps_searches`/`linkedin_searches.delivered_counts`. The margin substrate.
- **Post-review additions (same day, adversarial pass):** delivered-outcome **radial** in
  the Maps panel (exclusive `tier_*` buckets added to the ledger; `scripts/test-outcomes.ts`
  22/22); per-row **"already in CRM" badge** + count (the spend-visibility guard — compass
  has no blacklist, re-pulls re-pay); dead Scrap.io + decision-maker cron **schedules
  removed from vercel.json**; `preset_slug` provenance stamped; fixed an invalid route-file
  export.
- **Browser pass + FULL E2E — DONE (2026-08-25, pre-push):** panel verified in the dev
  preview (form, packs, estimate, presets, prior runs); then a real 12-place Dallas
  commercial-cleaning search ran through the actual crons end-to-end — auto-import 12 →
  enrichment auto-start → name-aware routing to site_scrape → 3 generic inboxes
  **backfilled into contacts.email** (`kind: company_generic`) + 12 phones → ledger
  stamped `{record:12, phone:12, company_email:4, tier_company:4, tier_phone:8}` → the
  radial + "In CRM" badges rendered the real numbers. Env fix en route: dev 500s from
  `prettier/plugins/html` were a stale node_modules (missing `prettier`) — `npm install`
  fixed it, lockfile unchanged. Only the **naming phase** hasn't run live (no Anthropic
  key in the org — its no-key fail-soft path is what executed).

**Verified:** tsc clean (0 new app-code errors); unit tests routing 19/19, outcomes 22/22,
pattern-mv 9/9, domain-discovery 30/30; live — compass I/O + pricing, Maps
sourcing→import→dedup, site_scrape on name-less trades domains, and the **full cron
pipeline end-to-end in the real app** (see the bullet above).

**Owner-name add-on LIVE-VALIDATED (2026-08-26):** the naming → pattern_mv flow ran
end-to-end on the 12 Dallas leads (local drive of the real crons, env Anthropic key):
**6/9 owner names found** (all via the Claude web-search Layer 2; Layer 1 site-reads
0/9) and **3/9 MV-`ok` verified personal emails** written to contacts. The run exposed
and fixed a latent API bug — both Claude web_search tool declarations were missing the
required `name` field, 400-ing every Layer 2 / domain-discovery call (commit `e07a0fd`).
Measured reality: the Claude web-search fallback costs ~$0.06–0.07/business (the
`NAMING_COST_USD` $0.015 estimate understates it — correction is a named open item);
a **Perplexity key in Settings → Integrations** is the economics lever (~5–10× cheaper
Layer 2) before any scaled naming run.

**Catch-all handling + found-first lists (shipped 2026-08-26):** "Include catch-all
guesses" is a per-run add-on in the Contacts enrich dialog and both Prospecting panels
(ORs over the org-level `accept_catch_all_guesses` setting via the run's config
snapshot); kept guesses store at confidence 40 with `provider_status: catch_all`,
badge amber everywhere, chart as their own radial segment, and land in a new exclusive
`tier_catch_all` ledger bucket so they never count toward the verified-personal price
tier. All finished lists (Contacts table, both panel results tables) sort found-first:
person → company inbox → catch-all → none (shared classifier
`src/lib/enrichment/email-tier.ts`, 15/15 + outcomes 31/31 unit-tested). Named open
item: the send-time "risky last" dispatch ordering in `run-native-sequences` (send
catch-alls only after verified-clean sends drain, small per-mailbox daily cap).

Full decisions, schema, e2e evidence, machine-move checklist, and next steps:
[`RESUME-MAPS-VEIN.md`](RESUME-MAPS-VEIN.md).

## Other initiative: LinkedIn Channel via Unipile

**Status:** All 9 code commits shipped (latest `64b45fd`). **NOT live yet** — gated on three migrations + Unipile config + webhook registration. No more code commits required for first activation.

**What it does:** Adds LinkedIn as a parallel outreach channel alongside native email. Per-client hosted-auth connect flow (Unipile-brokered), a sequence builder for multi-step outreach (connect_request → message → message → message), a 15-min cron worker that dispatches steps with per-account safety caps (80 connect/wk, 150 messages/day), and a Unipile webhook handler that ingests inbound DMs into the existing `lead_replies` AI classification + notification pipeline (reuses the email pipeline — `source_channel='linkedin'` is the only row-level difference).

**Resume doc with full activation checklist:** [`RESUME-LINKEDIN-CHANNEL.md`](RESUME-LINKEDIN-CHANNEL.md).

**Decisions locked in:**
- Hosted-auth (Unipile-brokered), not raw OAuth. Owner clicks Connect on the client detail page; client (or owner on their behalf) authorizes via Unipile's hosted page.
- One LinkedIn account per client (their own — not LeadStart's master).
- Reuse the existing AI classification + notification pipeline. No LinkedIn-specific classifier.
- Reply pipeline is channel-agnostic; only the inbound side and the campaign engine differ.
- Cookie expiry every 1–3 months → Unipile fires `account_disconnected` → flips `clients.unipile_account_status='expired'` → Reconnect button surfaces in the LinkedinSection UI.
- No AI auto-drafting on LinkedIn replies.
- Sequence engine: support `connect_request` + `message` for v0; `inmail` / `like_post` / `profile_visit` are reserved kinds until there's a real product use case.

---

## Reply pipeline (channel-agnostic, live for native email)

The Claude classifier + Resend hot-lead notification flow now runs against native email inbound replies (ingested by the `poll-native-replies` cron; LinkedIn DMs will join once that channel activates). Both channels hand off to the same `runReplyPipeline` in [`src/lib/replies/pipeline.ts`](src/lib/replies/pipeline.ts). Two-layer classifier (keyword prefilter → Claude Haiku) per [`src/lib/replies/decide.ts`](src/lib/replies/decide.ts) — the third "upstream tag" layer was removed when Instantly went away.

---

## Prospecting tab — phases shipped

**Phase 1 — Scrap.io plumbing:** API key in Settings, validate-key route, sidebar entry. Commit `2e35b1b`.

**Phase 2 — Background search:** cron-driven worker (`/api/cron/run-prospect-searches`), polling UI for live progress, save-to-CRM with email dedup, prospect_searches table with status lifecycle (migrations 00042 + 00043).

**Phase 3 — Decision-maker enrichment (code-complete):** Two-layer enrichment ported from the standalone LeadEnrich tool. Layer 1 = Claude Haiku scrapes the business website with a category-aware seniority hierarchy. Layer 2 = Perplexity Sonar (or Claude web_search) when the website yields nothing. Surfaced inline on the Scrap.io results table as a "Find decision makers" action; saved contacts get first/last/title/personal_email merged in via a `run_id` on the existing /save endpoint. Settings page gains Anthropic + Perplexity key cards. Migration 00044.

**Phase 3 next:** apply migration 00044, add Anthropic + Perplexity keys in /admin/settings/api, smoke-test end-to-end.

---

## What's Built

### Admin Dashboard (`/admin/*`)
| Page | Status | Notes |
|------|--------|-------|
| Overview | Done | Client cards with health badges, mini KPI metrics, sorted by risk |
| Clients list | Done | Add client form, client detail pages with campaign drill-down |
| Client detail | Done | Per-client campaigns, invite button, campaign-level analytics |
| Campaign detail | Done | KPIs, daily chart, refresh button |
| Campaigns | Done | All campaigns list with status badges |
| New native campaign | Done | Sequence builder for native email campaigns |
| Feedback | Done | Consolidated view of all client feedback with filters |
| Reports | Done | Generate draft → instant preview dialog, email preview, send button, quick date presets |
| Prospects/CRM | Done | Kanban-style pipeline, add/edit prospects |
| Billing | Done | MRR, subscriptions table, invoices, 3 pricing plans, Stripe placeholder |
| Events/Webhooks | Done | Event log with type badges |
| Team settings | Done | Team member list, role management |
| API settings | Done | Anthropic / Perplexity / Scrap.io key cards |

### Client Portal (`/client/*`)
| Page | Status | Notes |
|------|--------|-------|
| Dashboard | Done | Personalized header, KPIs, chart, campaign list. Excluded-meetings counter temporarily 0 (rebuild on native email events). |
| Activity Feed | Done | Real-time event timeline grouped by date. Temporarily empty (rebuild on native email events). |
| KPI Reports | Done | Report history with delivery status, per-campaign metric breakdown with trend arrows |
| My Feedback | Done | Summary cards (total/positive/negative), feedback history table |
| Campaign detail | Done | Per-campaign KPIs, chart, feedback submission form |

### Backend / Cron Workers
| Route | Schedule | Purpose |
|-------|----------|---------|
| `/api/cron/sync-analytics` | hourly | Rolls up native campaign analytics |
| `/api/cron/send-reports` | hourly | Emails KPI reports per client schedule |
| `/api/cron/run-linkedin-sequences` | every 15 min | LinkedIn sequence dispatcher (gated on activation) |
| `/api/cron/run-prospect-searches` | every minute | Scrap.io background search worker |
| `/api/cron/run-decision-maker-enrichment` | every minute | Two-layer decision-maker enrichment worker |
| `/api/cron/expire-replies` | 6am UTC | Marks old replies as expired |
| `/api/cron/retry-notifications` | every 2 min | Resend retry queue |
| `/api/cron/prune-webhook-events` | 4am UTC | Webhook audit log cleanup |
| `/api/cron/dispatch-owner-alerts` | every 5 min | Owner alert delivery |
| `/api/cron/owner-heartbeat` | 1pm UTC | Periodic owner ping |
| `/api/cron/run-native-sequences` | every 5 min | Native Gmail sequence dispatcher (per-mailbox ramp; Million Verifier pre-send gate) |
| `/api/cron/poll-native-replies` | every minute | Native Gmail reply + bounce ingest |
| `/api/cron/check-inbox-health` | hourly at :30 | Per-mailbox inbox-health score (DNS, blacklist, bounces, replies, seed placement) |
| `/api/cron/run-placement-tests` | every 10 min | Finalizes open seed placement tests; starts the weekly automatic probe per mailbox |
| `/api/webhooks/unipile` | inbound | LinkedIn DM ingest (gated) |
| `/api/webhooks/resend` | inbound | Email delivery status |

### Database
| Item | Status | Notes |
|------|--------|-------|
| Supabase migrations | Done | 51 migration files in `supabase/migrations/` |
| RLS policies | Done | Row-level security configured |

---

## What's NOT Built Yet

### Priority 1 — Rebuilds after Instantly purge
- [ ] **Client activity feed on native email events**: needs a proper `campaign_id` UUID FK on `webhook_events` + handlers writing to it + client/activity/page.tsx rewiring. Currently the feed renders empty.
- [ ] **Excluded-meetings counter**: same dependency. Currently always shows 0.

### Priority 2 — Email & Communication
- [ ] **Quote/proposal generator**: Branded PDF or HTML quotes for prospects
- [ ] **Automated report scheduling polish**: per-client schedules wired through admin UI
- [ ] **Receipt/invoice emails**: Automated payment confirmations

### Priority 3 — Billing & Payments
- [ ] **Stripe integration**: Connect Stripe account, create products/prices, subscription management
- [ ] **Stripe webhooks**: Handle payment events (succeeded, failed, canceled)
- [ ] **Client checkout flow**: Payment links or embedded checkout for onboarding

### Priority 4 — Polish & UX

#### Pagination audit (complete — commit `ff44ced`, 2026-05-09)
**Convention:** Default page size = 25 rows. Use [`PaginationControls`](src/components/ui/pagination-controls.tsx). Reset page to 1 on filter/sort changes. Counts and stat cards reflect the full filtered set, not the current page slice.

All flagged list views paginated: `admin/clients`, `admin/contacts`, `admin/prospecting`, `admin/feedback`, `admin/inbox` (server fetcher caps at 200), `admin/reports`, `admin/tasks`, `client/inbox`, `client/activity`, `client/feedback`, `client/reports`.

Out of scope: `admin/prospects` (kanban). `admin/campaigns` was paginated earlier at 10 per page; aligning to 25 is a follow-up if desired.

- [ ] **Font upgrade**: Replace default with a cleaner sans-serif (Inter or similar)
- [ ] **Alignment audit**: Verify vertical alignment across all stat cards and metric displays
- [ ] **Mobile responsive**: Test and fix all pages on mobile/tablet
- [ ] **Search functionality**: Make the search bar in topbar actually work
- [ ] **Notification system**: Make the bell icon functional with real notifications
- [ ] **Dark mode**: Theme is configured but not fully tested

### Priority 5 — Advanced Features
- [ ] **Lead read/unread tracking**: Custom status tracking in database
- [ ] **Client onboarding wizard**: Step-by-step flow for new client setup
- [ ] **VA permissions**: Granular access control for what VAs can see/do
- [ ] **Export/download**: CSV/PDF export for reports and data
- [ ] **Audit log**: Track who did what and when

---

## File Structure (Key Files)
```
src/
├── app/
│   ├── (auth)/login/          # Login page
│   ├── (dashboard)/
│   │   ├── admin/             # All admin pages
│   │   ├── client/            # All client pages
│   │   ├── dashboard-shell.tsx # Layout wrapper (sidebar + topbar)
│   │   └── layout.tsx         # Auth check + role detection
│   └── api/
│       ├── cron/              # Scheduled workers (see Backend table above)
│       ├── webhooks/          # unipile, resend, stripe
│       └── admin/             # Owner-only admin endpoints
├── components/
│   ├── charts/                # KPI cards, daily chart, stat card
│   ├── layout/                # Sidebar, topbar
│   └── ui/                    # shadcn components
├── lib/
│   ├── gmail/                 # Native Gmail API client + MIME + warmup ramp
│   ├── native/                # Native channel helpers (token rendering)
│   ├── unipile/               # Unipile client (LinkedIn)
│   ├── replies/               # ingest, prefilter, classifier merge, send
│   ├── ai/                    # Claude classifier + prompt
│   ├── email/                 # Email templates
│   ├── kpi/                   # KPI calculator + health definitions
│   └── supabase/              # Supabase server + admin + browser clients
├── types/app.ts               # TypeScript types
└── middleware.ts              # Auth middleware
```

---

## How to Continue This Project

On any machine with Claude Code or Claude Desktop:
1. Clone the repo: `git clone https://github.com/LeadStart/LeadStart.git`
2. `cd LeadStart && npm install && npm run dev`
3. Tell Claude: "I'm continuing work on the LeadStart project. Read CLAUDE.md and PROJECT_STATUS.md to get up to speed."
4. Claude will read these files and know exactly where things stand.

### To resume a specific in-flight initiative

If there's a "Current Initiative" section above, Claude should also read the linked resume doc. Resume docs live at the repo root (`RESUME-*.md`) and contain decision history + activation checklists.
