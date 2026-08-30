# LeadStart: Apify-native enrichment pipeline for email-less LinkedIn lists

> **RECONCILE NOTE (2026-08-23) — read first.** This document is the *original*
> design and still describes a 5-phase pipeline whose **phase 4 was an Apify
> "verification gate" (`michael.g/email-verifier-validator`, "Layer 4")**. That
> phase has been **removed**. When this feature was rebased onto `master`, master
> already shipped **Million Verifier** as the single source of truth for email
> verification (its own pre-send gate in `run-native-sequences`; migration
> `00069_add_email_verification`). To avoid two competing verifiers and a schema
> collision, verification was unified on Million Verifier:
>
> - The Apify pipeline is now **4 phases: profiles → domains → waterfall →
>   activity** (no `verify`). It writes `contacts.email` **fill-only** + provenance
>   in `enrichment_data`; it **never** writes `email_verification_*` (Million
>   Verifier owns those columns and the vocab `ok/catch_all/unknown/invalid/
>   disposable/error`).
> - `michael.g`, `VERIFY_ACTOR`, `run_verify`/`verify_actor`, the item `verify_*`
>   columns and the feature's parallel `EmailVerificationStatus` vocab/badge are
>   all gone; the UI adopts MV's `verificationBadge`.
> - The migration below shipped as **`00070_create_apify_enrichment.sql`** (00069
>   is Million Verifier's), **without** the 3 `contacts.email_verification_*`
>   columns.
>
> Everything below is retained for design/context; treat all `verify` /
> `michael.g` / "Layer 4" / 5-phase references as **historical**.
>
> **Also historical (noted 2026-08-30): `vdrmota~contact-info-scraper` was FULLY
> REMOVED 2026-08-24.** Treat the step-3 waterfall row (:54) and its I/O + pricing
> (:114-122) as historical too; the waterfall now routes site_scrape / pattern_mv /
> bovi (canonical costs: [`docs/APIFY_ACTOR_COSTS.md`](APIFY_ACTOR_COSTS.md)).

## Context

**Problem.** The SaaSassins cold-outreach list (1,933 LinkedIn profiles from Apify's profile-search
actor; 1,453 US decision-makers after QA) has **no emails** (1.7%) and **no company domains** — only
names, titles, company names, `linkedin.com/company/{id}` URLs and URN-style profile URLs
(`/in/ACwAA…`). LeadStart cannot ingest such a list today: every import path hard-drops rows without
an email (`src/lib/csv/parse-contacts.ts:153`, `import-dialog.tsx:187/204`); its only enrichment
engine (`src/lib/decision-maker/`) is keyed on Scrap.io search results (`search_id`/`google_id`
NOT NULL + UNIQUE in `decision_maker_results`) and cannot hold contact-keyed work; and LeadStart has
**no email-verification concept** at all — which the owner's own notes rank as the #1 unbuilt
deliverability gap ("pre-send email verification at import — none exists today").

**Goal.** Build the enrichment natively so any email-less LinkedIn list can be imported, matched to a
*verified* work email, and routed to the right existing channel — verified email → Gmail native
sequence, no email → LinkedIn (Unipile) sequence. Nothing downstream changes.

**Decisions made with the owner (2026-08-22):**
- Campaign scope **US only** (395 non-US contacts parked).
- **Apify only — no separate vendor subscriptions.** Tomba was rejected (poor Trustpilot, broken
  site); `overpowered/email-finder` rejected (one person per run, undocumented output); Icypeas (1★),
  Clearpath (2★) and Bovi (unrated, 86 users) are not reputable enough to be primary.
- Providers chosen by **reputation on the Apify marketplace** (rating × paid users × success rate):

| Step | Actor | Reputation | Price | Input we already have |
|---|---|---|---|---|
| 1. Profile + **email** (primary) | `harvestapi/linkedin-profile-scraper`, mode `"Profile details + email search ($10 per 1k)"` | 4.55★ · 64k users · 10.8k/mo · 98.4% success · no cookies | $0.01/profile (event `profile_with_email`); **not charged when a profile can't be searched**; SMTP-validated | profile URL / URN id (`ACwAA…` explicitly supported) |
| 2. Company → domain | `harvestapi/linkedin-company` | 4.46★ · 15.8k users · no cookies | $0.003–0.004/company | company LinkedIn URL |
| 3. Waterfall on misses | `vdrmota/contact-info-scraper` leads-enrichment (top-tier **community** actor — 4.72★ from **90 reviews**, 57.8k users, 12.8M runs, 100% success, whitelisted for agentic payments; NOT an Apify-official actor — earlier "Maintained by Apify" note was an error) — chosen because the owner's Apify account is on a **paid tier**; `bovi/email-finder-bulk` documented as the Free-tier fallback | 4.72★/90 | `lead-scraped` $0.005 (BRONZE+; would be $0.10 on FREE); `lead-email-verified` $0.004 (decisive only) | company domain (+ name match) |
| 4. Verification gate | `michael.g/email-verifier-validator` | 4.67★ · 1,484 users · 430/mo | $0.60/1k | any email not already decisively valid |

Approximate cost for the 1,453-person list: ≈ $15 (step 1) + ≈ $5 (step 2) + ≈ $3–9 (step 3) +
< $1 (step 4) → **≈ $25–30**, with ~60–75% ending up with a verified email and every remaining
person still addressable on LinkedIn. Trustpilot blocks automated reads, so HarvestAPI's standing
there is unverified; its evidence is Apify's paid-user ratings across several actors.

**Why this is simpler than the earlier design:** every step is an Apify batch actor, so the worker
has exactly **one** mechanism — start actor run → poll → ingest dataset — with no direct-API branch,
no per-vendor rate-limit pause, and no second key to manage.

## Architecture (mirrors the existing decision-maker pipeline)

```
Import (LinkedIn mode)   Enrich (bulk action)          Cron worker, every minute, 60 s
contacts w/ email=NULL → enrichment_runs + items  →  profiles ─▶ domains ─▶ waterfall ─▶ verify ─▶ complete
linkedin_url set          (one active run / org)     each phase: batch ≤100 pending items → one Apify run →
                                                      poll across ticks → ingest → write contacts + items
```

Phase order rationale: step 1 needs nothing but the profile URL and is the highest-yield step, so
it runs first; domains are still resolved for every contact (cheap, needed by the waterfall and
useful data); the waterfall only touches contacts still without an email; verification only
touches emails whose status isn't already decisive.

Patterns reused verbatim: worker `src/app/api/cron/run-decision-maker-enrichment/route.ts`
(atomic claim, per-item status stamping, cost/progress aggregation, finalize; `maxDuration = 60`,
`dynamic = "force-dynamic"`, `checkCronAuth`); provider client `src/lib/scrapio/client.ts` (plain
`fetch`, 3 attempts, exp backoff); per-org keys + `require*Context()` gate (`src/lib/scrapio/auth.ts`,
`src/lib/decision-maker/auth.ts`); run tables + RLS `supabase/migrations/00044_…sql`; start/read
routes `src/app/api/admin/prospecting/decision-makers/{start,run/[id],runs}/route.ts`; settings card
+ validate route (`settings/api/page.tsx` Scrap.io card L869-959, `prospecting/validate-key/route.ts`);
client poller `prospecting/page.tsx` `pollDmRunOnce` (L301-326) copied into a new component (the
prospecting page is NOT refactored); email sanity helpers `src/lib/decision-maker/validation.ts`.

## External API facts (verified 2026-08-22)

**Apify REST v2** (token via `Authorization: Bearer`; no npm client — `fetch` like `ScrapioClient`):
start `POST /v2/acts/{username~actor}/runs?waitForFinish≤60&timeout=1200` (body = actor input) →
`{data:{id,status,defaultDatasetId}}`; read `GET /v2/actor-runs/{id}` → `status ∈ READY|RUNNING|
SUCCEEDED|FAILED|TIMING-OUT|TIMED-OUT|ABORTING|ABORTED`, `usageTotalUsd`, `statusMessage`; abort
`POST /v2/actor-runs/{id}/abort`; items `GET /v2/datasets/{id}/items?clean=true&offset&limit` (bare
array, `X-Apify-Pagination-Total`); `run-sync-get-dataset-items` blocks ≤300 s → **not usable** in a
60 s route; key probe `GET /v2/users/me`; public actor metadata `GET /v2/acts/{id}` (pricing events).

**harvestapi~linkedin-profile-scraper**: input `{ profileScraperMode: "Profile details + email
search ($10 per 1k)", urls?: [...], profileIds?: [...], publicIdentifiers?: [...], queries?: [...] }`;
output per profile: `id, firstName, lastName, headline, about, location{…}, linkedinUrl,
currentPosition[]{companyName, companyLinkedinUrl, companyId}, experience[], …` + email field(s)
(**name not shown in the sample JSON — pin on the first live call**; map any `email`/`emails`/
`emailStatus`-like keys; absence → `not_found`). Join results to inputs by the URN id
(`/in/(ACw[A-Za-z0-9_-]+)` from both input URL and output `id`/`linkedinUrl`), fallback
first+last match.

**harvestapi~linkedin-company**: input `{ companies: [url…] }` (also `searches: [name…]`); output
`{ name, linkedinUrl, id, website, employeeCount, industries, … }`; no input echo → join by numeric
company id (`/company/(\d+)`) vs output `id` / id in `linkedinUrl`, fallback slug, fallback
normalized name; unresolvable companies may be omitted → `not_found`.

**vdrmota~contact-info-scraper** (official): input `{ startUrls:[{url}], maxDepth, maxRequestsPerStartUrl,
sameDomain:true, maximumLeadsEnrichmentRecords: N (0 = off), leadsEnrichmentDepartments: [...],
verifyLeadsEnrichmentEmails: true }`; output per start URL `{ domain, emails[], phones[], linkedIns[],
…, leadsEnrichment[]{ firstName, lastName, fullName, jobTitle, headline, departments, seniority, email,
mobileNumber, companyName, companyWebsite, companyLinkedin, linkedin profile, verification status
(when enabled) } }`. Events: `pages-scraped` $0.002, `lead-scraped` $0.005 (BRONZE+; $0.10 FREE),
`lead-email-verified` $0.004 decisive-only. We match our person by normalized first+last (then by
`linkedin` URL id); generic `emails[]` (info@…) are stored as `enrichment_data.enrichment.company_emails`
for manual use, never written to `contacts.email`.

**bovi~email-finder-bulk** (Free-tier waterfall): input `{ people:[{firstName,lastName,domain}],
verifySmtp:true, maxAlternatives:0 }`; output `{ email, confidence 0–1, status: verified|accept_all|
unverified_guess|no_mx|harvested, … }`.

**michael.g~email-verifier-validator**: input `{ emails:[…] }`; output `{ email, status: good|risky|bad,
technical_status: valid|invalid|unknown|catch_all|disposable|error, score 0–100, free, role,
disposable, catch_all }`.

Normalized email result used everywhere: `{ email: string|null, status: 'verified'|'catch_all'|
'risky'|'invalid'|'unknown'|'not_found', confidence: 0–100, provider, raw }`. Status maps:
profile scraper → `verified` when its output marks the email valid/SMTP-checked, else `unknown`
(pin live); vdrmota `lead-email-verified` valid→`verified`, invalid→`invalid`, disposable→`risky`,
unverified→`unknown`; bovi `verified→verified`, `accept_all→catch_all`, `unverified_guess|harvested→
unknown`, `no_mx→invalid`; michael.g `valid→verified`, `catch_all→catch_all`, `unknown|error→unknown`,
`disposable→risky`, `invalid→invalid`.

## Repo rules that bind this work (from LeadStart `CLAUDE.md`, `AGENTS.md`, `memory/`)

- **Local-only by default.** No `git commit`/`git push` without the owner saying so in the current
  turn; `master` auto-deploys to production (no staging). Work on local branch
  `feature/apify-enrichment` off `master`.
- **Session-start protocol** (step 0): `git pull origin master`, `git status`, `git log --oneline
  -5`, report; `npm install` if `package.json` changed. Verified 2026-08-22: local `master` ==
  `origin/master` (`ac5729c`); the `claude/million-verifier-api-e6d960` branch is empty.
- **Git author** for any authorized commit: `LeadStart <daniel@leadstart.io>` (this machine's default
  is Kronelius) → set repo-local `git config user.name/user.email` first.
- **`basePath: "/app"`** — every API call is `/app/api/...`; client code uses `appUrl()`.
- **`contacts.status` is the dispatch lifecycle** (new → queued → uploaded → active → …) and is
  never written by this feature; enrichment state lives in the new columns + tags.
- **No local Supabase.** Local dev and prod share project `exedxjrifprqgftyuroc`; migrations are
  applied with `node scripts/supabase-sql.mjs --file …` (Management API) as one statement batch →
  `00069` is purely additive and idempotent, applied only on an explicit "go".
- Next.js 16 ("not the Next.js you know") — mirror the existing cron/route files; `ignoreBuildErrors`
  masks pre-existing strict-null errors, so `npx tsc --noEmit` and fix only files we touch.
- Dev preview: `.claude/launch.json` preset `leadstart-dev` (port 3000); auth via
  `GET /app/api/dev/login`.

## Data model (migration `supabase/migrations/00069_create_apify_enrichment.sql`)

Purely additive, idempotent (`IF NOT EXISTS` / `DROP … IF EXISTS` everywhere), no enum changes.

```sql
SET search_path TO public;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS apify_api_key TEXT;   -- env fallback APIFY_API_TOKEN

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS company_linkedin_url TEXT,
  ADD COLUMN IF NOT EXISTS company_domain TEXT,
  ADD COLUMN IF NOT EXISTS email_verification_status TEXT
    CHECK (email_verification_status IS NULL OR email_verification_status IN
      ('verified','catch_all','risky','invalid','unknown','not_found')),
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verification_provider TEXT;   -- 'harvestapi'|'vdrmota'|'bovi'|'michael.g'
CREATE INDEX IF NOT EXISTS idx_contacts_org_linkedin
  ON contacts (organization_id, lower(linkedin_url)) WHERE linkedin_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS enrichment_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES profiles(id),
  -- provider snapshots (changing code constants never re-targets an in-flight run)
  profile_actor TEXT NOT NULL, domain_actor TEXT NOT NULL, waterfall_actor TEXT, verify_actor TEXT,
  run_profiles BOOLEAN NOT NULL DEFAULT TRUE, run_domains BOOLEAN NOT NULL DEFAULT TRUE,
  run_waterfall BOOLEAN NOT NULL DEFAULT TRUE, run_verify BOOLEAN NOT NULL DEFAULT TRUE,
  phase TEXT NOT NULL DEFAULT 'profiles'
    CHECK (phase IN ('profiles','domains','waterfall','verify','complete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','failed')),
  total_count INT NOT NULL,
  phase_total_count INT NOT NULL DEFAULT 0, processed_count INT NOT NULL DEFAULT 0,   -- per current phase
  found_emails_profiles_count INT NOT NULL DEFAULT 0, found_domains_count INT NOT NULL DEFAULT 0,
  found_emails_waterfall_count INT NOT NULL DEFAULT 0, verified_count INT NOT NULL DEFAULT 0,
  found_emails_count INT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  active_apify_run_id TEXT, active_apify_dataset_id TEXT, active_batch_started_at TIMESTAMPTZ,
  active_batch_attempt INT NOT NULL DEFAULT 0, consecutive_failures INT NOT NULL DEFAULT 0,
  locked_at TIMESTAMPTZ,                                   -- 90 s tick lease
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, progress_message TEXT, error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_org_recent ON enrichment_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_active ON enrichment_runs (created_at) WHERE status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_enrichment_runs_one_active_per_org
  ON enrichment_runs (organization_id) WHERE status IN ('pending','running');   -- race-safe 409

CREATE TABLE IF NOT EXISTS enrichment_run_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES enrichment_runs(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  linkedin_url TEXT, profile_id TEXT,                      -- snapshots / join keys
  company_linkedin_url TEXT, company_id TEXT, company_slug TEXT, company_name TEXT,
  first_name TEXT, last_name TEXT, company_domain TEXT,
  profile_status   TEXT NOT NULL DEFAULT 'pending' CHECK (profile_status   IN ('pending','in_flight','found','not_found','skipped','error')),
  domain_status    TEXT NOT NULL DEFAULT 'pending' CHECK (domain_status    IN ('pending','in_flight','found','not_found','skipped','error')),
  waterfall_status TEXT             CHECK (waterfall_status IS NULL OR waterfall_status IN ('pending','in_flight','found','not_found','skipped','error')),
  verify_status    TEXT             CHECK (verify_status    IS NULL OR verify_status    IN ('pending','in_flight','found','not_found','skipped','error')),
  profile_apify_run_id TEXT, domain_apify_run_id TEXT, waterfall_apify_run_id TEXT, verify_apify_run_id TEXT,
  profile_notes TEXT, domain_notes TEXT, waterfall_notes TEXT, verify_notes TEXT,   -- per-step: bulk updates set literals
  email TEXT, email_verification_status TEXT CHECK (email_verification_status IS NULL OR email_verification_status IN
      ('verified','catch_all','risky','invalid','unknown','not_found')),
  email_provider TEXT, confidence INT,
  attempts INT NOT NULL DEFAULT 0,                        -- failed attempts in the CURRENT phase
  cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_enrichment_items_run ON enrichment_run_items (run_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_items_contact ON enrichment_run_items (contact_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_items_profile_pending   ON enrichment_run_items (run_id, created_at, id) WHERE profile_status   = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_domain_pending    ON enrichment_run_items (run_id, created_at, id) WHERE domain_status    = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_waterfall_pending ON enrichment_run_items (run_id, created_at, id) WHERE waterfall_status = 'pending';
CREATE INDEX IF NOT EXISTS idx_enrichment_items_verify_pending    ON enrichment_run_items (run_id, created_at, id) WHERE verify_status    = 'pending';
DROP TRIGGER IF EXISTS set_enrichment_items_updated_at ON enrichment_run_items;
CREATE TRIGGER set_enrichment_items_updated_at BEFORE UPDATE ON enrichment_run_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS: same predicate as 00044, both tables, 4 policies each, each as DROP POLICY IF EXISTS + CREATE POLICY
ALTER TABLE enrichment_runs ENABLE ROW LEVEL SECURITY;  ALTER TABLE enrichment_run_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners and VAs view their org's enrichment runs" ON enrichment_runs;
CREATE POLICY "Owners and VAs view their org's enrichment runs" ON enrichment_runs FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
-- … INSERT (WITH CHECK) / UPDATE / DELETE, and the same four for enrichment_run_items.
```

## Backend

### `src/lib/apify/` (new; mirrors `src/lib/scrapio/`)
- `client.ts` — `ApifyClient(token)`: `getMe()`, `startActorRun(actorId, input, {waitForFinishSec≤60,
  timeoutSec:1200})` (retries **only on 429**, never on a thrown network error — a POST that may have
  reached Apify must not be replayed), `getRun`, `abortRun`, `getDatasetItems({offset,limit})`,
  `getAllDatasetItems()` (page 1000, cap 10k), `getActorPricing(actorId)` (optional, for the UI
  estimate). `Authorization: Bearer`; `encodeURIComponent` keeps `~`.
- `types.ts`, `auth.ts` (`loadApifyToken(admin, orgId)` = `organizations.apify_api_key ||
  process.env.APIFY_API_TOKEN`; `requireEnrichmentContext()` = DM-style gate that does NOT 400 on a
  missing key — the start route decides), `pricing.ts` (per-event constants for the UI estimate:
  profile+email 0.01, domain 0.004, waterfall lead 0.005 / bovi found 0.00475, verify 0.0006).
- `domain.ts` (pure) — `normalizeDomain(website)` (scheme/`www.`/path/port stripping, IP/localhost/
  no-dot rejection, `REJECTED_HOSTS` suffix list: linkedin/facebook/instagram/x/youtube/tiktok/google/
  sites.google/wix/squarespace/godaddysites/weebly/wordpress.com/blogspot/bit.ly/linktr.ee/crunchbase/
  glassdoor/indeed/yelp/medium/github.io/notion.site/carrd.co; registrable domain = last 2 labels or 3
  for a small `MULTI_PART_TLDS` set; no PSL dep), `extractProfileId(url)` (`/in/([A-Za-z0-9_-]+)`),
  `extractCompanyId`, `extractCompanySlug`, `normalizeCompanyName`.
- `email-sanity.ts` — `sanitizeFoundEmail(email, person)`: reject (→ `not_found`) on anchored
  `EMAIL_FULL` fail or `isJunkEmail`; flags in notes only: name mismatch (`emailMatchesName`), generic
  mailbox (`isPersonalEmail`), email domain ≠ company domain.
- **One provider interface for every phase** — `providers/types.ts`:
  `PhaseProvider<TItem> = { id; actorId; buildInput(items) → unknown; parseItems(datasetItems, items) →
  Map<itemId, PhaseResult> }` where `PhaseResult = { status: 'found'|'not_found', email?, emailStatus?,
  confidence?, companyDomain?, companyLinkedinUrl?, extra?, raw }`.
  `providers/profile-harvestapi.ts` (mode string constant; input `urls` from `linkedin_url`; join by
  URN id then name; maps email + `currentPosition[0].companyLinkedinUrl/companyId`),
  `providers/company-harvestapi.ts` (join id → linkedinUrl id → slug → unique name),
  `providers/waterfall-vdrmota.ts` (`startUrls` = `https://{company_domain}`, `maxDepth 1`,
  `maxRequestsPerStartUrl 10`, `maximumLeadsEnrichmentRecords 10`, `verifyLeadsEnrichmentEmails true`;
  join by start-URL domain, then match our person by normalized first+last or `linkedin` id; company
  `emails[]` → `enrichment_data.enrichment.company_emails`), `providers/waterfall-bovi.ts`
  (`people[]`, join by echoed name/domain → positional → email-domain + `emailMatchesName`),
  `providers/verify-michaelg.ts` (`emails[]`, join by lower(email)). `providers/index.ts` —
  `PROFILE_ACTOR`, `DOMAIN_ACTOR`, `WATERFALL_ACTOR = "vdrmota~contact-info-scraper"` (owner
  confirmed a paid Apify tier on 2026-08-22; `bovi~email-finder-bulk` stays registered as the
  documented Free-tier fallback — one-line constant swap), `VERIFY_ACTOR`, `getProvider(phase, actorId)`.

### API routes
- `POST /api/admin/contacts/enrich/start` (`maxDuration 30`): `{contact_ids[], run_profiles=true,
  run_domains=true, run_waterfall=true, run_verify=true}`; ≤2,000 ids; Apify key required (400 naming
  `/admin/settings/api`); active run → **409** `{error, active_run_id}` (pre-check + 23505). Loads
  contacts in chunks of 500; eligibility → item rows: profiles needs `email IS NULL` and a parseable
  `linkedin_url`; domains needs `company_domain IS NULL` and a parseable `company_linkedin_url`
  (may also be filled by the profile phase — the worker re-checks); waterfall/verify statuses are
  assigned by `advancePhase`. Items with no pending step aren't inserted; none → 400 `{error, skipped}`.
  Inserts run (actor snapshots, `phase = run_profiles ? 'profiles' : 'domains'`) then items (chunks of
  500; failure → delete run → 500). Returns `{run_id, total, skipped:{not_found_in_org, no_linkedin_url,
  already_has_email, no_company_linkedin_url, already_has_domain}}`.
- `GET /api/admin/contacts/enrich/run/[id]` → `{run, items}` (items via `.range()` — PostgREST caps at
  1,000 rows). `GET /api/admin/contacts/enrich/runs` → `{runs (last 20), active}`.
- `POST /api/admin/apify/validate-key` `{api_key}` → `getMe()` → `{success, username, plan}`.

### Cron `src/app/api/cron/run-apify-enrichment/route.ts` (`maxDuration 60`, `force-dynamic`, `checkCronAuth`)
Constants: `BATCH_SIZE=100` (profiles/domains/waterfall), `VERIFY_BATCH_SIZE=500`, `LEASE_MS=90_000`,
`STUCK_AFTER_MS=20 min`, `APIFY_TIMEOUT_SEC=1200`, `MAX_ITEM_ATTEMPTS=2`, `MAX_CONSECUTIVE_FAILURES=3`,
`START_BUDGET_SEC=45`, `WRITE_PARALLEL=10`.

Tick: (1) candidate = oldest run with `status in (pending,running)`; (2) **lease claim** — `update
{status:'running', started_at, locked_at:now} … .in(status) .or('locked_at.is.null,locked_at.lt.<now-90s>')
.select()` → 0 rows → `claim_failed` (the DM-style claim alone lets overlapping ticks both proceed
once a run is `running`; with paid calls that's not acceptable); (3) Apify token via `loadApifyToken`
→ missing → run `failed`; (4) `phase === 'complete'` → finalize, else `apifyBatchPhase(run, phase)`;
any throw → `consecutive_failures+1` (3 → `failed`, else `progress_message = "Retrying after error: …"`);
(5) `recomputeCounters` (four `count:'exact', head:true` queries on the phase's status column) and
release `locked_at` on every exit path.

`apifyBatchPhase(run, phase)` — identical for all four phases; `provider = getProvider(phase,
run.<phase>_actor)`:
- **A. active Apify run** → `getRun`: in progress → update `progress_message`, return (abort and treat
  as failed if older than 20 min); `SUCCEEDED` → page the dataset, join to the phase's `in_flight`
  items via `provider.parseItems`, write results (below), add `usageTotalUsd` (else estimate) to
  `cost_usd`, clear `active_*`, `consecutive_failures=0`; if < 30 s elapsed start the next batch;
  `FAILED|TIMED-OUT|ABORTED` → in-flight items with `attempts<2` back to `pending` (+1) else `error`
  with the Apify status message; clear `active_*`; `consecutive_failures+1`.
- **B. no active run** → recover orphans (in-flight items carrying a `<phase>_apify_run_id` → adopt it;
  without one → `pending`); take ≤`BATCH_SIZE` `pending` items ordered `(created_at, id)`; re-check
  contacts (profiles/waterfall: email now set → `skipped`; domains: domain now set → `skipped`);
  `provider.buildInput(items)`; **call Apify first** (`waitForFinish = clamp(45−elapsed, 0, 20)`), then
  mark items `in_flight` + `<phase>_apify_run_id`, then set `active_*` with an
  `.is('active_apify_run_id', null)` guard (0 rows → `abortRun` + throw). Calling first bounds the
  crash window to one orphan Apify run (≤ one batch of cost); marking first would leave an ambiguous
  placeholder on crash. Empty batch → `advancePhase`.

Writes per phase (all contact updates are fill-only and guarded):
- **profiles**: found email → `writeEmail(item, contact, result, 'harvestapi')`; also
  `company_linkedin_url` if the contact lacks one (`.is('company_linkedin_url', null)`), and
  `enrichment_data.enrichment.profile = {headline, currentPosition, location, scraped_at}`; profile
  scraped but no email → item `not_found`; profile not returned → `not_found` ("profile not found").
- **domains**: `update contacts {company_domain, enrichment_data.enrichment.company} … .is('company_domain', null)`;
  company found but unusable website → `not_found` (note raw website); no match → `not_found`.
- **waterfall**: vdrmota → person matched → `writeEmail(…, 'vdrmota')` with the add-on's verification
  status; no person match → `not_found` (+ `company_emails` stored); bovi → `writeEmail(…, 'bovi')`.
- **verify**: `update contacts {email_verification_status, email_verified_at, email_verification_provider:
  'michael.g', enrichment_data.enrichment.verification} … .eq('email', item.email)`; `invalid` → also
  append tag `invalid-email`; item `found` (decisive) / `not_found` (still unknown).

`writeEmail(item, contact, result, providerId)`: `not_found`/no email → item `not_found`;
`sanitizeFoundEmail` reject → `not_found` + reason; `invalid` → store only in `enrichment_data`
(never write a known-bad address), item `found` with status `invalid`; otherwise `update contacts
{email, email_verification_status, email_verified_at (null when 'unknown'), email_verification_provider,
tags: uniq([...tags,'enriched',providerId]), enrichment_data} … .is('email', null)` — **`contacts.status`
is never written** — `23505` (email already on another contact in the org) → item `skipped`, address
kept in `enrichment_data.enrichment.email_conflict`; 0 rows → `skipped`; ok → item `found` (+cost).

`advancePhase`: `profiles` → `domains` (if `run_domains`; items whose contact already has a domain →
`domain_status='skipped'`; attempts reset) else on; `domains` → `waterfall` (if `run_waterfall`:
`waterfall_status='pending'` for items with `profile_status='not_found'` AND a `company_domain`,
`'skipped'` ("no domain") otherwise; none → on); `waterfall` → `verify` (if `run_verify`:
`verify_status='pending'` for items holding an email whose `email_verification_status` ∉
('verified','invalid'); none → on); `verify` → `finalize` (`status='complete'`, `phase='complete'`,
summary `progress_message`).

Tick JSON: `{status: idle|claim_failed|waiting|adopted|started|harvested|batch_failed|skipped_batch|
advanced|complete|error|failed, id?, phase?, apify_run_id?, …counts}`.

### Config / env / types
- `vercel.json`: `{ "path": "/app/api/cron/run-apify-enrichment", "schedule": "* * * * *" }`.
- `.env.example`: `APIFY_API_TOKEN` (optional local fallback; per-org key in Settings is primary).
- `src/types/app.ts` (single source for both halves): `Organization.apify_api_key`;
  `EmailVerificationStatus`; `EmailProviderId = "harvestapi"|"vdrmota"|"bovi"|"michael.g"`;
  `Contact` + `company_linkedin_url`, `company_domain`, `email_verification_status`,
  `email_verified_at`, `email_verification_provider: EmailProviderId | null`; `EnrichmentRunStatus`,
  `EnrichmentPhase = "profiles"|"domains"|"waterfall"|"verify"|"complete"`, `EnrichmentStepStatus`,
  `EnrichmentRun` / `EnrichmentRunItem` (every column; `cost_usd: number | string`).

### Idempotency & safety
One active run per org (pre-check + partial unique index) · items unique per (run, contact) · 90 s
lease · Apify never re-called for a batch whose run id is persisted (adoption rule) · one retry per
item per phase · 3 consecutive failures fail the run · Apify `timeout=1200` + 20-min stuck abort ·
`contacts.email` written only `WHERE email IS NULL`, conflicts → `skipped` with the address preserved ·
`invalid` never reaches `contacts.email` · `contacts.status` never written. Deliberate simplicity:
one provider interface, constants not per-run choices, no cancel route (follow-up), no PSL list.

## Frontend: import mode, bulk Enrich action, run banner, table/filters, settings

Order: types → `admin-queries.ts` columns → banner component → contacts page → import dialog →
lib aliases → settings card. `npx tsc --noEmit` after the first two and at the end (the
`satisfies Partial<Contact> & { id: string }` at `import-dialog.tsx:352` is the type tripwire).

### `src/lib/admin-queries.ts` — required, easy to miss
`CONTACT_LIST_COLUMNS` (L41-44) is an explicit select string; add `company_linkedin_url,
company_domain, email_verification_status, email_verified_at, email_verification_provider`.

### New `src/components/contacts/enrichment-run-banner.tsx` (client)
Exports `ENRICH_POLL_INTERVAL_MS = 3000`, `fetchActiveEnrichmentRunId()` (`active?.id ?? null` from
`GET /api/admin/contacts/enrich/runs`) and `<EnrichmentRunBanner runId onDone? onDismiss? />`. Poller
copied from `prospecting/page.tsx` (L294-335): timer ref, `cache:"no-store"` fetch of
`/enrich/run/{id}`, stop on complete/failed, `doneFiredRef` (fire `onDone` once per run), `onDoneRef`.
Copy: pending → "Queued — waiting for the worker"; running → "Finding emails from LinkedIn profiles
(HarvestAPI) · n/N" / "Resolving company domains · n/N" / "Second pass on misses · n/N" / "Verifying
emails · n/N"; complete / failed (`error_message`). Line 2: "Emails found A (+B second pass) · Domains
X/Y · Verified V · est. cost $Z · {progress_message}". Dismiss only in a terminal state.

### `src/app/(dashboard)/admin/contacts/page.tsx`
- Imports `Sparkles`, `Link`, `EmailVerificationStatus`, banner + `fetchActiveEnrichmentRunId`;
  cost constants `ENRICH_COST_PROFILE = 0.01`, `ENRICH_COST_DOMAIN = 0.004`,
  `ENRICH_COST_WATERFALL = 0.005` (per miss, upper bound), `ENRICH_COST_VERIFY = 0.0006`.
- Helpers after `TagsCell`: `EmailStatusFilter` (all / verified / needs_enrichment (`!email`) /
  risky (catch_all|risky|unknown) / invalid (invalid|not_found)), `matchesEmailStatusFilter`,
  `EMAIL_STATUS_BADGE` (emerald / amber / red outline, like prospecting `LOCATION_BADGES`),
  `<EmailStatusBadge>` with `title` = provider + "checked {date}".
- State (ALL above the early `if (loading) return` at ≈L453): `emailStatusFilter`; enrich dialog
  state (`enrichDialogOpen`, four `enrichRun*` booleans default on, `enrichStarting`, `enrichError`,
  `activeRunId`); mount effect resuming `activeRunId` via `fetchActiveEnrichmentRunId()`; add
  `emailStatusFilter` to the page-reset effect deps. Filter application at ≈L270.
- Eligibility from `selectedContacts`: `needsEmail` (no email, has `linkedin_url`), `needsDomain`
  (has `company_linkedin_url`, no `company_domain`), `enrichEstimate`, `unverifiedSelected`.
- `handleStartEnrichment`: POST `/enrich/start` `{contact_ids, run_profiles, run_domains,
  run_waterfall, run_verify}` → set `activeRunId`, close, clear selection, `toast.success` with
  `Object.values(skipped)` summed; any non-OK (400 missing key / 409 active run) shows the server
  text verbatim with `<Link href="/admin/settings/api">` (Next `Link` auto-prefixes `/app`).
- Filter UI: "Email status" `<Select>` after the status select (≈L704). Bulk bar (between the
  client-only "Add to Campaign" block and Delete): outline `Enrich` button. Banner between the bulk
  bar and the table; `onDone` → `refetch()` + `swrMutate("admin-contacts-with-pipeline")`.
- Table: `Domain` column (`hidden lg:table-cell`) after Company; email cell `row.email ?? "—"` +
  `<EmailStatusBadge>`. Campaign dialog: non-blocking amber line "N selected contacts have no verified
  email — use a LinkedIn campaign for those." (`handleBulkAssignCampaign` untouched).
- Enrich dialog (clone of the campaign dialog shell; native `<input type="checkbox">` — no
  `checkbox.tsx` exists): "Find emails from LinkedIn profiles (HarvestAPI) — $0.01 each, only when
  searchable", "Resolve company domains — $0.004 each", "Second pass on misses — ≈ $0.005 per miss",
  "Verify emails before sending — $0.0006 each"; estimate line; error block; Cancel / "Start enrichment".
- `<ImportContactsDialog onEnrichStarted={(id) => { setActiveRunId(id); setImportOpen(false); }}>`.
- **Null-email fixes in this file**: edit-dialog save guard (require email OR linkedin),
  `email: form.email.trim() || null`, delete-confirm fallback `|| "this contact"`, `Email *` label →
  "Email or LinkedIn URL required", Save-disabled condition. Flag only (out of scope):
  `admin/prospects/page.tsx` `(x.company_name || x.email).charAt(0)` throws when both null.

### `src/app/(dashboard)/admin/contacts/import-dialog.tsx`
- `type ImportMode = "standard" | "linkedin"`; pill toggle above the file picker; mode switch → `reset()`.
- `LINKEDIN_HEADER_ALIASES` overlay merged into the LOCAL alias table only in LinkedIn mode:
  `profile url|linkedin profile url|linkedinurl|profile → linkedin_url`; `company linkedin url|company
  linkedin|companylinkedinurl|company url|currentpositions/0/companylinkedinurl → company_linkedin_url`;
  `domain|company domain|website|company website → company_domain`; raw Apify
  `currentpositions/0/companyname → company_name`, `currentpositions/0/title → title`,
  `location/linkedintext → location` (custom field); `emailintext|email in text → email`. In LinkedIn
  mode drop custom columns whose header contains `/`.
- `STANDARD_FIELDS` += `company_linkedin_url`, `company_domain`; `normalizeHeader(h, aliases)`;
  `rowsFromCSV(text, mode)`: no missing-email error in LinkedIn mode; row valid if `linkedin_url` OR
  (first+last+company); `email: string | null`; `company_domain` cleaned; returns `{rows, skipped[]}`.
- `handleImport`: in-file dedupe (lower(email); normalized linkedin key); DB dedupe chunked 200
  (`.in("email")` and, in LinkedIn mode, `.in("linkedin_url", variants)`); insert in chunks of 200;
  `23505` → per-row fallback counting duplicates (pattern: `api/campaigns/[id]/client-import/route.ts`
  L490-517); collect client-generated `insertedIds`; result `{inserted, skipped_duplicates, insertedIds}`.
- Payload diff: `email: r.email ?? null`, `company_linkedin_url`, `company_domain`,
  `tags: [...tags, "linkedin"]`, `source: "linkedin-import"`; `status: "new"` unchanged.
- Preview (LinkedIn mode): Name / Company / LinkedIn / Company URL / Domain + "N rows skipped".
  Result box adds **"Enrich these N now"** → POST start with `insertedIds` (all four steps on) →
  `onEnrichStarted(run_id)`; error verbatim + settings link.

### `src/lib/csv/parse-contacts.ts`
Add only unambiguous aliases to the shared table (`profile url`, `linkedin profile url`, `linkedinurl`,
`company linkedin url`, `companylinkedinurl`, `currentpositions/0/companylinkedinurl`, `company
domain`, `currentpositions/0/companyname`, `currentpositions/0/title`) — NOT `profile`/`website`/
`domain` (they'd hijack campaign merge variables). The campaign import panel stays email-required.

### `src/app/(dashboard)/admin/settings/api/page.tsx`
One new **Apify** card after Scrap.io (clone of the Scrap.io card + `handleSaveScrapioKey` /
`handleTestScrapio`): `Bot` icon, password input `apify_api_…`, helper "Find your token at
console.apify.com → Settings → Integrations. Powers LinkedIn profile → email, company → domain, the
second-pass email search and email verification in Contacts → Enrich.", Test → `POST
/api/admin/apify/validate-key` → "Connection successful — {username} · {plan}". Load from
`typedOrg.apify_api_key`. Sidebar: no change.

## Implementation order (each slice compiles on its own; nothing is committed or pushed)
0. Session protocol (`git pull origin master`, `git status`, `git log --oneline -5`) → branch
   `feature/apify-enrichment`.
1. Migration file `00069` (written, **not applied**) + `src/types/app.ts` + `admin-queries.ts`.
2. `src/lib/apify/*` (client, domain, sanity, the five providers) + `scripts/test-apify-enrichment.ts`
   → run the no-network tests.
3. API routes + cron worker + `vercel.json` + `.env.example`.
4. Settings card → import-dialog LinkedIn mode → contacts page → `parse-contacts.ts` aliases.
5. `lint` / `tsc` / `build`; surface the SQL and wait for "go" before applying `00069`; then the
   end-to-end run with a 5–10 row slice of the KEEP list.

**Pin on the first live call (mappers are written defensively until then):** the profile scraper's
email output field(s) and any validity flag; whether the official contact scraper's `leadsEnrichment`
records expose a verification-status field name as documented; harvestapi company acceptance of
numeric-id URLs (`/company/19178324`) — if slug-only, fall back to `searches: [company_name]`.

## Verification

**Static (every slice):** `npm run lint` · `npx tsc --noEmit` (fix only errors in files we touch) ·
`npm run build`.

**No network:** `scripts/test-apify-enrichment.ts` (`npx tsx`, same harness style as
`scripts/test-inbox-health.ts`): `normalizeDomain` table, `extractProfileId/CompanyId/CompanySlug`,
each provider's `parseItems` on fixture JSON (profile join by URN id / name; company join
id → url-id → slug → name, omitted input → `not_found`; vdrmota person match by name + `linkedin`;
bovi echoed/positional/email-domain joins; michael.g status map), `sanitizeFoundEmail`, and
`ApifyClient` against a monkeypatched `fetch` (bearer header, pagination, 429 retry on GET, no retry
on POST network error). Live smoke behind `APIFY_API_TOKEN`: `getMe()`, one profile+email run with
3 KEEP rows (prints raw items so the email field gets pinned), one company run with Pritchard /
Marsden / CleanNet (expect `pritchardindustries.com`, `marsden.com`, `cleannetusa.com`).

**Migration (only on explicit "go"; prod DB):** `node scripts/supabase-sql.mjs --file
supabase/migrations/00069_create_apify_enrichment.sql`, then `SELECT column_name FROM
information_schema.columns WHERE table_name='contacts' AND column_name LIKE 'email_verification%'`
and `SELECT count(*) FROM enrichment_runs`; re-running the file must be a no-op.

**End-to-end in the dev preview** (`preview_start name=leadstart-dev`, then `GET /app/api/dev/login`):
1. Settings → Integrations: Apify card save/test (bad key → verbatim error; good key → username/plan).
2. Contacts → Import → "LinkedIn list (no emails)" → import `~/Downloads/LinkedIn_List_Analysis/
   KEEP_send_ready.csv` (5–10 rows): no missing-email error; preview shows LinkedIn/Company URL;
   re-import → all duplicates skipped, no alert.
3. Select rows → Enrich → counts/estimate → Start → toast + banner "Queued".
4. Drive the worker by hand: `curl -H "Authorization: Bearer $CRON_SECRET"
   http://localhost:3000/app/api/cron/run-apify-enrichment` once per tick; watch the banner advance
   profiles → domains → waterfall → verify → complete; Domain column + email-status badges fill;
   `enrichment_run_items` carry per-step statuses/notes; `enrichment_runs.cost_usd` populated
   (`node scripts/supabase-sql.mjs "select phase,status,processed_count,phase_total_count,cost_usd,
   progress_message from enrichment_runs order by created_at desc limit 3"`).
5. Negative paths: second run while active → 409 shown in the dialog; remove the key → 400 naming
   Apify + settings link; a found email that already exists on another contact → item `skipped`,
   contact email stays NULL; an `invalid` verification → badge red, tag `invalid-email`, email kept
   out of `contacts.email` when it came from this run.
6. Refresh mid-run → banner resumes; filters "Verified" / "Needs enrichment" narrow correctly; the
   campaign dialog shows the amber no-verified-email warning.
7. Proof for the owner: screenshot of the completed banner + table, plus the SQL summary.

**Deploy readiness (not executed without permission):** local branch only; on "commit/push": set
`git config user.name "LeadStart" && git config user.email daniel@leadstart.io`, commit, push
`master` (auto-deploys); optionally set `APIFY_API_TOKEN` on Vercel if the env fallback is wanted.
