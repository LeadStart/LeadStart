# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.

---

## 2026-09-05: Native send + cron runtime audit (Tier 1 + Tier 2) — 7 LOCAL commits, NOT pushed

`/cto-audit` run over the native email send runtime (run-native-sequences,
poll-native-replies, src/lib/gmail, src/lib/native, the Million Verifier gate,
suppression) plus the mechanics of all 23 cron routes, with three bolt-on lanes
(tsc-to-zero, live RLS delta, error boundaries). Six finder agents + three
bolt-on agents in parallel; every candidate adversarially verified.

**Reconciliation: 98 candidates = 86 confirmed + 2 refuted + 10 superseded; 93
areas verified clean.** Full record: `SEND_RUNTIME_AUDIT.md` (living doc,
findings SEND-01..71 and CRON-01..18 with file:line evidence, the known-vs-assumed
ledger with the Vercel + Google doc quotes, refuted list, clean list, shipped /
open / declined sections). Registry row + pathway ticks in `AUDITS.md`.

**Headline findings (all fixed locally):**
- CRON-01 critical: `POST /api/cron/send-reports` had NO auth and the middleware
  forwards every /api/ request unauthenticated, so anyone on the internet could
  mail any client's KPI report to arbitrary addresses or bulk-send reports.
- SEND-35/62/63 (prod-confirmed): the sender's two global 60-row enrollment
  fetches ignored campaign status, send window, due-ness and benched mailboxes;
  prod showed 35 of 60 fetched rows not due and 30 due follow-ups unfetched, and
  a paused/draft campaign could silently starve every other campaign.
- SEND-64: the "at-most-once, no locking" stance was TESTED against Vercel's
  docs, which say a second cron instance can run while the first is running and
  the same scheduled run can be delivered twice; a compare-and-set claim on
  current_step_index now runs right before every Gmail send (no lease, no
  migration). 0 duplicates in 1,802 prod sends so far, so this was latent.
- SEND-50/53: prefetch errors were read as empty sets (one transient DB error
  permanently failed or completed up to 120 enrollments, or mailed DNC'd leads).
- SEND-19/18/20: every Gmail 403 benched the mailbox although Google uses 403
  for quota reasons; network errors and mailbox-level 400s permanently failed
  leads.
- SEND-01/02/04: the reply poller advanced its watermark past unread mail,
  re-read DSNs inflated bounces into the circuit breaker, and re-upserts reset
  handled replies to "new" (duplicate portal send possible).

**Commits (local master, unpushed):** `9dbae48` cron fleet, `96c448d` send
runtime + Gmail client, `7bed81c` reply poller + MIME, `75a6bef` small items,
`43e5031` error boundaries, `f9d9536` tsc to zero + `ignoreBuildErrors=false`
(build passes twice), `d7081f1` migration 00126 RLS delta (NOT applied), plus the
docs commit. Verified: tsc 0 errors, six test suites green (23/39/42/27/11/46),
MIME probe re-run, `npm run build` green.

**For Daniel:**
1. The push decision. Everything is local. `git push origin master` deploys to
   prod (switch `gh` to LeadStart first). After the first tick, check the cron
   JSON for `claimed_elsewhere`, `deadline_hit`, `truncated`, and any 500 with
   "prefetch failed" (a 500 now means "wait 5 min", never lost leads).
2. Apply `supabase/migrations/00126_rls_delta_hardening.sql` via the dashboard
   SQL editor as ONE call (push_subscriptions policy scope + REVOKE on three
   service-role-only tables). Not applied by the audit.
3. Vercel dashboard: confirm Fluid compute is on (Settings > Functions); every
   cron route now carries an explicit maxDuration either way.
4. Policy calls listed under "Open" in SEND_RUNTIME_AUDIT.md: max-staleness for
   follow-ups after a long pause (SEND-37), MV error-x5 policy (SEND-59), DNC
   cross-channel (SEND-71), 3-inboxes-per-domain enforcement (SEND-69),
   cron-created Workspace passwords (CRON-14).
5. Delete `src/app/(dashboard)/admin/clients/[clientId]/client-actions.tsx`
   (dead since migration 00015; the permission gate would not let the tsc lane
   remove it) and, when convenient, the two dead Scrap.io cron routes + their
   seven producer routes (CRON-15).
6. One live test only you can run: a follow-up with its own subject sent with
   the original threadId (SEND-24), comparing the returned threadId.

**Parked to the enrichment pathway (out of scope here):** SEND-54 (pattern-finder
verdict never cached, so the send gate re-bills MV) and CRON-09 (run-apify-
enrichment releases its lease before the same-tick ingest).

**Method notes for the next audit:** the Management API runs as
`supabase_read_only_user`, so `information_schema.role_table_grants` returns 0
rows (false negative); use `pg_class.relacl` / `has_table_privilege()`. The
clone's highest migration is 00122 (no 00123-00125 exist locally); two files
share number 00111.

---


## 2026-08-31: Porkbun URL forwarding + provisioning reliability — SHIPPED to master. First live Porkbun provision run.

Session started as an eval ("can we push domain forwarding for Porkbun/Spaceship?")
and turned into a build + a full live provisioning debug. All pushed to master
(deployed): commits `1232ace`/`3670391` (feature + reliability), `cb4b1ff` (status
banner), and the doc/test/wizard-forwarding batch.

**URL forwarding (the ask).** Porkbun's API supports URL forwarding; Spaceship's does
NOT (dashboard-only, verified against their API docs). Built it provider-agnostic:
`RegistrarProvider.supportsUrlForwarding` + `get/setUrlForwards`; Porkbun implements
`add/get/deleteUrlForward` with a pure idempotent by-subdomain diff in
`src/lib/registrar/forwarding.ts` (apex + www, 301 permanent, includePath off);
Spaceship throws `ManualForwardingRequiredError`. Surfaces: `GET`/`POST
/api/admin/registrar/forward`; a per-domain **URL forwarding** panel in the Mailboxes
domain detail (`domain-provisioning-detail.tsx` — set/change after the fact, works for
active domains since every row is expandable); an optional forward field in the
onboarding wizard's Review step (best-effort on Create, Porkbun only). Settings-card
notation says Porkbun = API, Spaceship = manual.

**Provisioning reliability (found live while provisioning tubeforseo.com).** Root cause
of the first-run break: the "Set up inboxes" wizard let a domain be set to Porkbun while
Porkbun wasn't connected → the DNS step **silently skipped** → the verification TXT was
never written → opaque Google 400 three steps later. Fixes (all shipped):
- `provisioning-runner.ts`: a non-manual registrar with no API client now FAILS the DNS
  step with an actionable message (not a silent skip). Site-verification wait shows a
  hint pointing to the Google Admin verify (Site Verification confirms, but the Workspace
  Directory flag can lag / needs the Admin-console verify for API-added secondary domains).
- `add-mailbox-wizard.tsx`: errors scroll into view (were off-screen → "nothing happens"
  on Create); the registrar picker shows what's actually connected + warns on an
  unconnected pick + defaults to a connected registrar.
- `registrar/settings/route.ts` + card: per-field presence, so a key saved **without its
  secret** shows a "secret missing" warning (Porkbun key is `pk1_…`, secret is `sk1_…`).
- `domain-provisioning-detail.tsx`: a current-step status banner (step + full untruncated
  message + "checked Nx / last checked / re-checks automatically").

**Live outcome.** Porkbun connected (both key+secret), tubeforseo.com provisioned end to
end (Google MX in, Porkbun `fwd1/fwd2` MX auto-deleted by the exclusive-group rule, Google
SPF/DMARC, inbox created); the Directory-flag lag was cleared by verifying the domain in
Google Admin. Only DKIM remained (owner pastes/starts it → domain flips to warming).

**Tests:** `scripts/test-registrar.ts` 120/120 (forward builder/diff/mapping + explicit
fwd1/fwd2.porkbun.com MX-cleanup), `scripts/test-provisioning.ts` 55/55 (missing-key fail
+ verify-wait hint). tsc clean on all touched files.

**Not a bug (verified live via DoH):** gotubeseo.com still shows Porkbun defaults only
because it isn't tracked in the app (never provisioned). tubeforseo's live DNS proves the
write + MX-cleanup work. Per-domain provisioning is the model — connecting Porkbun does
not retroactively rewrite existing domains. Possible future nicety: a one-click "sync DNS
across tracked Porkbun domains."

---

## 2026-08-31: Token product Phases 0-3 + 5 DEPLOYED. Phase 4 DESIGNED (decisions LOCKED). Next = build Phase 4 (new worktree).

**UPDATE (end of session):** Phases 2/3/5 were PUSHED to prod — master `10311fe`
(fast-forward from 5efff85), verified live (401 on `/api/buyer/prospecting/searches`
+ `/api/admin/tokens/config` = deployed + auth-gated). The token product is now
LIVE but INERT until the owner sets pack + tier prices in Admin → Settings → Tokens.
**Phase 4 is DESIGNED + owner-decided** (see the dedicated entry below + the
kickoff chip): `docs/plans/token-phase4-master-pool.md`, decisions LOCKED
(Option A = enrich-in-place → promote to a shared `master_contacts` pool → own via
a ledger; buyers keep/download; NO resale discount; simple broad dedup; re-verify
deferred). Next session builds it in a fresh worktree.

Continued straight through the phases (owner directive: build all the way through).
Plan `C:\Users\danie\.claude\plans\ok-we-need-a-gentle-peach.md`, memory
[[project_token_contact_sourcing]]. **Phases 0-1-2-3-5 are DEPLOYED (master `10311fe`).**
Migrations 00104-00110 are APPLIED to prod. The 2 parallel-session commits stay on
local branch `parallel-session-wip` (not mine to push).

**Phase 2 — wallet + Stripe + admin config (`d49fd71`).** `token_ledger`
(credit/hold/charge/release + `token_balances` view + idempotency) & config
tables (00108/00109/00110, applied). Stripe reuse: the app's Stripe is already
wired and the quote flow uses ad-hoc `price_data` (no pre-made products), so
token packs are data-driven from `token_packs.price_usd` — "define the 3 packs"
= just entering prices (packs seeded, prices NULL by owner choice). Built:
`createTokenPackCheckoutSession` + `POST /api/billing/tokens/checkout` +
`token_topup` webhook credit (service-role, idempotent). Buyer portal shows real
balance + a purchasable-pack grid. Admin Settings HUB (folded in from worktree
`internal-automations-setup-9d84fc`, sidebar/topbar merged with Phase 1) + a
controlled Tokens config page wired to `POST /api/admin/tokens/config` (owner-only).

**Phase 3 — reserve/cap/settle (`195203c`), the cash core.** `src/lib/tokens/`
`pricing-math.ts` (pure, unit-tested 12/12) + `billing.ts`: `placeHold` (gates on
pricing + available balance) and `settleSearch` (recomputes charge+release from
CUMULATIVE `delivered_counts` and UPSERTS — idempotent-and-additive across the
multiple enrichment runs a search drains over, resolving the one-settlement-row-
per-search vs many-runs tension). Guarded settle hook in `finalizeOutcomes`
(run-apify-enrichment:~2515), a NO-OP for agency searches (no hold). Buyer
reserve-wrapped Maps + LinkedIn routes (`/api/buyer/prospecting/*`) — reserve
FIRST via a pre-generated id (race-free; token_ledger.search_id has no FK), roll
the hold back if the insert loses the one-active-per-org race. Charge basis is
attribute-based off OUTCOME_KEYS→tier_key mapping. Reserve→settle + re-settle
balance math verified via rollback harness (`scripts/test-token-billing.ts` +
the SQL harness). tsc/eslint 0 new.

**Phase 5 — buyer UI (`32cb827`).** `/buyer/search` Maps form → the reserve route
(shows reserved tokens / insufficient / not-priced-yet), recent-searches table
with live status+delivered polling, "Run a search" in buyer nav. Balance + buy on
`/buyer` (Phase 2).

**DEFERRED (deliberate):**
- **Phase 4 shared master-contacts pool + cross-buyer resale/segment-cache** — a
  RISKY refactor of the agency's core org-scoped `contacts` model. Per-buyer dedup
  (don't double-bill) ALREADY works via the existing org-scoped import dedup, so
  the core loop is fine without it. The shared-pool/resale change needs its own
  careful design pass; do NOT rush it into the live contacts table.
- **Cap-config wiring** (`token_pricing_config.max_charge_per_run_usd` →
  the crons' hardcoded `maxTotalChargeUsd`) — the hold is the primary cash gate;
  this is a secondary vendor-spend ceiling. Small, self-contained.
- **`catch_all_recovered` (Findymail) billing** — no engine OUTCOME_KEY; detect via
  `enrichment_data.enrichment.email.provider === "findymail"` in finalizeOutcomes.
- **Re-verify tier + low-balance alert email** (Phase 5 tail).

**Activation (owner):** set pack + tier prices in Admin → Settings → Tokens (Stripe
already live → priced packs = working buy flow); then push. Full E2E (buyer buys →
runs a search → settle) needs a buyer account + priced packs + a real Stripe payment.

---

## 2026-08-30: Token product Phase 1 (buyer accounts + signup + portal) DONE. Migrations live. Next = Phase 2.

Buyer self-serve accounts on top of the Phase 0 hardening (plan
`C:\Users\danie\.claude\plans\ok-we-need-a-gentle-peach.md`, memory
[[project_token_contact_sourcing]]). D1's double-walled isolation: one org per
buyer + a new `'buyer'` app_role that fails-closed on every agency RLS policy.

**Migrations APPLIED to prod + verified (Management API):** `00106`
(`ALTER TYPE app_role ADD VALUE 'buyer'` — its own migration per the enum
same-txn rule, applied raw) and `00107` (`organizations.kind` default 'agency' /
`is_self_serve` + kind CHECK + index; every existing org reads 'agency'). Verified
`app_role = {owner,va,client,buyer}` and the columns/constraint/index live.

**Public signup path:** `POST /api/signup` — the ONLY signup route (Supabase
public signup stays `disable_signup:true`; this trusted service-role route uses
`admin.createUser`, which is not gated by it). Flow: guards (Phase 0 rate-limit +
Turnstile + disposable-email) → create unconfirmed user → create the buyer org →
promote the trigger-made profile to `role='buyer'` + org (service-role, so the
enforce trigger permits it) → magic-link confirmation email. Public form at
`/app/(auth)/signup/page.tsx` (self-contained, TurnstileWidget inert until keys).

**Routing + portal:** `src/lib/auth/roles.ts` (`roleHomePath`/`isAdminRole`)
DRYs the role→home map. Middleware gains buyer post-login routing + THREE
complete portal-boundary guards (a buyer can't reach /admin or /client, and
non-buyers can't reach /buyer; guards bounce only KNOWN foreign roles to avoid
redirect loops) + `/signup` in the public allowlist. `AppRole` += 'buyer';
page.tsx, dashboard-shell, sidebar (`buyerNav`), mobile-tab-bar (`buyerTabs`),
topbar get buyer arms. Portal shell at `/app/(dashboard)/buyer/`
(layout + `buyer-data-context` + a dashboard page: welcome + token-balance-0 +
coming-soon tiles for Phase 2/3).

**Verified:** tsc + eslint add 0 new issues (2 lint hits in touched files are
pre-existing); `/signup` renders in the dev preview (screenshot); the buyer guard
bounces an admin off /buyer → /admin; no console/server errors. NOT yet done
(needs a real inbox): the full signup E2E (confirm-email click → land on /buyer).

**Git note:** this session's Phase 0 + Phase 1 landed on master via branch
`claude/token-phase0-security` (rebased onto origin/master), deliberately
EXCLUDING 2 parallel-session commits (`63dd28d` spam-word-list CI gate +
`028aa2c` send-test-email) that add `.github/workflows/ci.yml` the LeadStart gh
token can't push without `workflow` scope. Those 2 are preserved on local branch
`parallel-session-wip`; that session re-pushes them (with the scope) when ready.

**Next = Phase 2** (token wallet + Stripe purchase + price-card persistence):
bring in the admin Tokens config shell from worktree
`internal-automations-setup-9d84fc` (branch `claude/frosty-edison-b9e42c`) first;
Stripe products/webhook config is a Daniel-dependency.

---

## 2026-08-30: Token product Phase 0 (security HARD GATE) DONE + pushed. Signup disabled. Next = Phase 1.

Phase 0 of the prepaid-token self-serve contact-sourcing product (plan
`C:\Users\danie\.claude\plans\ok-we-need-a-gentle-peach.md`, memory
[[project_token_contact_sourcing]]). Two privilege-escalation holes that were
exploitable independent of the product are now CLOSED on prod, plus the public
signup-abuse surface is hardened.

**Fixed + APPLIED to prod (Management API, project exedxjrifprqgftyuroc):**
- **Migration `00104`** — `handle_new_user` no longer trusts caller-supplied
  `raw_user_meta_data` for role/organization_id/client_id (a public signUp could
  have minted `role='owner'`); it now inserts only id/email/full_name (role
  defaults to 'client', org NULL), privileged assignment stays in the
  service-role invite route which already upserts the profile + client_users. Plus
  a new `enforce_profile_privileged_columns` BEFORE UPDATE trigger that blocks
  `authenticated`/`anon` from changing role/organization_id/is_active (RLS alone
  can't compare NEW vs OLD; the JWT hook reads profiles.role, so a self-write was
  a real self-promotion). Verified live: handle_new_user body has no metadata
  role read; trigger present on public.profiles. Backward-compatible with the
  deployed app (service-role writes are exempt; only anon self-write is full_name).
- **Migration `00105`** — shared `rate_limits` table + `consume_rate_limit` RPC
  (fixed-window, atomic, service_role-only, RLS-denied to anon/authenticated).
  The in-memory Map on /api/site-chat is per-instance; this is the cross-instance
  store the FAQ route itself named as the upgrade path. Smoke-tested live
  (rolled back): trips exactly at the limit.

**Behavioral proof:** `scripts/verify-phase0-security.sql` — a rollback-guarded,
throwaway-schema harness faithful to PostgREST's `SET LOCAL ROLE` model. 5/5 pass
(signup metadata ignored; client cannot self-promote; client CAN still edit own
full_name; service_role CAN still set role). Ran non-destructively against prod
with the owner's OK; left it byte-identical.

**App-level guards (pushed this session, activate on deploy):** `src/lib/security/`
`rate-limit.ts` (+ `clientIp`, `tooManyRequests`, fails OPEN if the store is
unreachable), `turnstile.ts` (inert until `TURNSTILE_SECRET_KEY`; fail-closed once
set), `disposable-email.ts` (bundled blocklist, active immediately); client
`src/components/security/turnstile-widget.tsx` (inert until
`NEXT_PUBLIC_TURNSTILE_SITE_KEY`). Wired into `api/contact` (rate-limit IP+email +
Turnstile + disposable block), `reset-password` (both modes), `accept-invite`
(token brute-force), `invite` (per-owner limit + role allowlist).

**Dashboard (owner-verified via Management API):** access-token hook ENABLED
(`custom_access_token_hook`); **public signup DISABLED** (`disable_signup:true`) —
Phase 1's `/api/signup` uses service-role `auth.admin.createUser`, which is NOT
gated by that toggle, so this is the permanent posture.

**Still open for the owner (not blocking Phase 1 build):** Turnstile keys
(`TURNSTILE_SECRET_KEY` + `NEXT_PUBLIC_TURNSTILE_SITE_KEY`) to activate that gate;
the marketing-site quote form (repo `LeadStart/Website`) needs the widget + to
POST `turnstileToken` to /api/contact.

**Next = Phase 1** (buyer accounts + auth + portal shell): `'buyer'` app_role,
`organizations.kind`/`is_self_serve`, buyer-scoped tables + RLS, public
`/buyer/signup` + `POST /api/signup` service-role provisioning, middleware/layout
`role==='buyer' → /buyer` branch, `buyerNav`, `/buyer` route group mirroring
`client/`. Building locally now; migration apply + push await the owner's word
(standing local-only rule — the Phase 0 push was an explicit one-time go).

---

## 2026-08-30: Apify spend audit COMPLETE (find + adversarial verify). Fix gate OPEN. $4.61 credit left this cycle.

Triggered by the $14.17 per-place-cap incident (a probe sent compass's
`maximumLeadsEnrichmentRecords: 400` believing per-RUN; schema says per PLACE;
chains delivered rosters). Full multi-agent audit of the actor/spend subsystem:
6 finder lanes → 4 adversarial verifiers + 2 direct reproductions.
**Reconciled: 74 candidates − 16 dupes = 58 unique = 53 CONFIRMED + 1 partial +
4 REFUTED; +13 verifier-found; ~69 areas clean.** Living record:
[`APIFY_SPEND_AUDIT.md`](APIFY_SPEND_AUDIT.md); registry:
[`AUDITS.md`](AUDITS.md); canonical costs (live-pulled):
[`docs/APIFY_ACTOR_COSTS.md`](docs/APIFY_ACTOR_COSTS.md) +
`scripts/pull-actor-costs.mjs` (mandatory pre-run protocol).

Top confirmed: no `maxTotalChargeUsd`/app budget anywhere (every run's platform
cap = entire remaining credit); dead circuit breaker in run-apify-enrichment
(`:278` reset clobbers the increment, no kill, no alert); start-before-persist
orphan window in all 3 actor crons (a network blip = orphaned billing run +
duplicate start); deep-search bills per SEGMENT page (billed 4.5x a real panel
estimate); search cost recording reads once pre-aggregation (measured 961x
under); Contacts dialog "up to ~$" omits its own naming/Findymail toggles;
"live pricing" serves FREE tier on our BRONZE account; add-on OR-merge runs
paid phases over whole merged runs; the per-place cap trap is documented
NOWHERE forward-looking (flow doc + unified plan).

**OPERATIONAL: $4.61 of $29 Apify credit left until 9/23 (hard 403 at cap).**
5 fix batches proposed in the audit doc; NOTHING ships without Daniel's
explicit go-ahead. Also still parked: leads-toggle keep/scrap (half-built,
lever currently unreachable), MV-verify the 23 probe emails (≤$0.09).

---

## 2026-08-29 — Maps DIY: DONE + admin-only. OWNER DIRECTIVE: NO client-portal exposure yet (Phase 6 ON HOLD).

The Maps DIY Google-Maps search flow is **complete and live on prod, ADMIN-ONLY** —
`maps-diy-panel.tsx` in Admin → Prospecting → Business (Google Maps), backed by the
multi-region cron fan-out, the DB-backed `geo_places` gazetteer + debounced
`geo-typeahead` (dynamic search IS wired), and structured `areas[]`. Verified zero
client exposure: no `/client/prospecting` route, clientNav has no Prospecting entry,
routes gated by `requireEnrichmentContext` (owner/VA only).

**OWNER DIRECTIVE (do not violate): NO client-portal exposure of prospecting yet — do
NOT give clients visibility to ANY of this.** This supersedes the "only Phase 6 remains
to build" framing in the entry just below: **Phase 6 (a client `/client` prospecting
route + client auth/RLS + billing hooks) is ON HOLD / DO NOT BUILD** until Daniel
explicitly greenlights it. Keep the flow admin-only. The admin build + delivered-outcome
ledger stand ready for when he does. (A live multi-region run still spends Apify $ — cap first.)

---

## 2026-08-27 — Maps DIY flow: Phases 2–5 SHIPPED to prod (admin). Only Phase 6 (client portal) remains.

Built + verified + pushed the whole DIY Google-Maps lead-search flow through the
admin surface. Everything below is live on master (auto-deployed). Migrations
`00094` + `00095` are APPLIED to prod and `geo_places` is SEEDED. **The one
remaining piece is Phase 6 — the client-portal surface — which is a deliberate
HARD STOP pending Daniel's surface decision (new `/client` route + client
auth/RLS + billing-ledger hooks).**

**Phase 2 — multi-region cron fan-out (commit `38ee657`).** [`run-maps-searches`](src/app/api/cron/run-maps-searches/route.ts)
now fans out ONE compass run per structured area, sequentially: start area[i] →
poll → ingest+accumulate → dedupe by `google_place_id` → advance cursor → next
area; when all done, slice the union to `target_max_results` and complete (then
auto-import + enrich). Per-area cap = `ceil(target/areaCount)`. Single-area
(`locationQuery`) rows keep the unchanged single-run path. Migration **`00094`**
= `maps_searches.area_index` cursor (applied). Deploy-safe regardless of migration
timing: the hot-path claim SELECT never references `area_index` (read lazily only
in the multi-area handler). Pure helpers in [`maps-search.ts`](src/lib/apify/sourcing/maps-search.ts):
`coerceMapsArea(s)`, `perAreaMaxItems`, `mergeMapsPlaces`, `ingestAreaResult`.
Poll route [`maps-searches/[id]`](src/app/api/admin/prospecting/maps-searches/[id]/route.ts)
overlays accumulated-∪-live. Verify: unit `scripts/test-maps-fanout.ts` 47/47;
`scripts/e2e-maps-fanout.ts` 16/16 (live DB, `complete`-status throwaway row =
zero Apify spend, never prod-cron-grabbable).

**Phase 3 — areas[] route + shared gazetteer (commit `dc12c11`).** [`maps-search route`](src/app/api/admin/prospecting/maps-search/route.ts)
accepts structured `areas: MapsArea[]`, validates via `coerceMapsAreas`, forces
every state to its full NAME ("TX"→"Texas"), writes `query.levers.areas`; the
`locationQuery` path stays (either/or, never both). **`geo_places` shared
gazetteer** (migration **`00095`**, applied + seeded): 51 states + 3,143 counties
+ 19,452 incorporated cities = **22,646 rows** (Census reference; CDP noise
dropped). Prefix + kind + trigram + natural-unique indexes; measured **~2ms**
indexed lookup. Bundled [`src/lib/geo/us-states.ts`](src/lib/geo/us-states.ts)
(51-row abbr↔name↔FIPS — the ONLY geo bit bundled). [`geo-typeahead endpoint`](src/app/api/admin/prospecting/geo-typeahead/route.ts)
= balanced per-kind prefix query, served by the service-role client, **nothing in
the browser bundle**. Seed pipeline: `scripts/build-geo-seed.ts` → committed
`supabase/seed/geo-places.tsv` (666KB seed asset, NOT app-bundled) →
`scripts/seed-geo-places.mjs`. **This table is the future LinkedIn fork's picker
too** (shared reference DATA, veins still separate; replaces the retiring Scrap.io
type-ahead). Verify: `scripts/test-us-states.ts` 25/25; `scripts/e2e-geo-typeahead.ts`
13/13; endpoint live over HTTP; route 400 paths live.

**Phases 4–5 — D+cart picker, mounted (commit `df14ad7`).** [`maps-diy-panel.tsx`](src/app/(dashboard)/admin/prospecting/maps-diy-panel.tsx):
LEFT = "Where are your customers?" Smart Search picker (gazetteer type-ahead →
grouped Cities/Counties/States dropdown + ZIP detection + quick-add states) →
multi-region area chips, then ready-to-run audience cards; RIGHT = sticky "Your
search" cart (Areas/Audiences/Enrichment/how-many-leads/estimate+tier-mix/Run),
surgical updates. Sends `levers.areas`; reuses poll/import/preset/pricing/in-CRM/
found-first/radial. Mounted in the Prospecting "Business (Google Maps)" tab,
**replacing** `MapsSearchPanel` (deleted — superseded; single-area = one area).
Verify (dev preview, sidebar client-nav per [[project_preview_pane_raf_hydration]]):
renders, no console errors, "Dallas"→grouped Cities(7 states)+Counties(5), built a
2-area cart + audience, estimate renders. Run NOT clicked (a live 2-area run needs
a $ cap). tsc 0 new (19 baseline), eslint clean throughout.

**REMAINING — Phase 6 (client portal), HARD STOP for Daniel's decision.** Expose
the DIY flow to clients: a new `/client` prospecting route, client auth/RLS on
`maps_searches` + `geo_places` reads, and the billing-ledger hooks the delivered-
outcome ledger prices against (outcome-tier $0.05→$0.30/lead). The admin build is
the reference. Also latent: the LinkedIn picker can now be swapped onto
`geo-typeahead` (separate future fork). NOTE: a valid multi-area search POST
creates a `pending` row prod's every-minute cron grabs → a REAL paid multi-region
Apify run — so any live paid test needs a $ cap.

---

## 2026-08-28: DNS registrar + Google Workspace provisioning SHIPPED to prod; Google activation VERIFIED

**Goal:** finish the two "API integrations" for the Gmail-tier growth path — buying/DNS-ing sending
domains (plan Phase 2) and creating Google Workspace inboxes on them (Phase 3). Both are now
code-complete and unit/build-verified. Full plan + activation checklist:
[`docs/plans/deliverability-infrastructure-plan.md`](docs/plans/deliverability-infrastructure-plan.md)
§5–§6 (status blocks refreshed). Session plan: `we-need-to-finish-glimmering-toucan.md`.

**Context correction:** Phases 1/2/5 + a Phase-6 slice were already ON master (commits `557bae7`→
`974745c`, migrations 00081–00085 applied) — the plan doc's "local, unpushed" notes were stale. The
registrar layer existed but was unreachable (no UI), had no DNS-verify loop (a bought domain stuck in
`provisioning` forever), Porkbun's upsert was append-only, and Spaceship was locked out by a
price-parse bug. Google Workspace provisioning was 0%.

**Built + SHIPPED this session (7 work packages, committed as `2d57e11` + `e603403`, pushed to master):**
- **WP1** `src/lib/google/auth.ts` — extracted the DWD JWT minter into a shared `GoogleServiceAccount`
  with a **scope-aware** token cache (old key was scope-blind). Gmail errors subclass the Google ones;
  Gmail client public API byte-identical. `scripts/test-google-auth.ts` 23/23.
- **WP2** DNS finish: pure `diffDnsRecords` (TXT by semantic slot, never deletes strangers; MX/A/etc
  exclusive) → Porkbun true upsert (create/edit/delete), Spaceship read-merge-write + price-parse fix
  + contacts + 202 async-op. `registrar/sweep.ts`; `/provision` gained a `registrar` forced-choice +
  spend-cap owner alert + `expires_at`; `scripts/probe-spaceship.ts` (read-only). `test-registrar.ts` 84/84.
- **WP3** migration `00097` (`organizations.google_admin_email` + license SKU cols; `sending_domains.provisioning`
  JSONB; idempotent mailbox→domain re-backfill) + `ProvisioningState` types + **fixed the mailbox POST
  never setting `domain_id`** (latent 00081 bug: every hand-added mailbox was invisible to lifecycle).
- **WP4** `src/lib/google/{directory,site-verification,licensing,org}.ts` + `deliverability/provisioning.ts`
  (pure) + `provisioning-runner.ts` (advancer). Passwords returned once, never stored. `test-provisioning.ts` 48/48.
- **WP5** routes `POST /api/admin/domains` (track owned), `…/[id]/{workspace,provisioning/advance,dkim,dns,dns/apply}`,
  `/api/admin/registrar/{quote,suggest}`, and cron `advance-domain-provisioning` (every 10 min, vercel.json).
  The provisioning→warming flip is applied by the cron itself, NOT gated by `domain_lifecycle_enabled`.
- **WP6** Admin → Mailboxes: **split Porkbun | Provision domain card** (quote → two price tiles, cheaper
  pre-selected → buy), "track an existing domain", and a per-domain provisioning stepper (setup form,
  Check now, DKIM paste, one-time password reveal, DNS panel). Plan/runbook/PROJECT_STATUS docs updated.

**Verification:** `npm run build` ✓ (all 9 new routes registered); tsc clean (0 new; 19 pre-existing);
eslint clean; unit — google-auth 23, registrar 84, provisioning 48, lifecycle 88 (regression). No live
Google/registrar calls yet (WP7).

**STATUS — WP7 (deploy + Google activation DONE; registrar keys + a paid provision test remain):**
0. **DONE 2026-08-27:** migration `00097` APPLIED to prod via the Supabase Management API SQL endpoint
   (`SUPABASE_ACCESS_TOKEN` in `.env.local`; scratchpad apply script, preview→apply→verify). All 4 columns
   present; backfill linked 0 (the 5 existing mailboxes were already linked by 00081).
0b. **DONE 2026-08-28 — Google Workspace setup COMPLETE + VERIFIED WORKING.** Driven via Claude in Chrome
   on the `workwithdanielt.com` Workspace (admin `daniel@workwithdanielt.com`): added the 4 new DWD scopes
   to the `leadstart-native-sender` SA client ID (client ID `100674264706186842509`), enabled Admin SDK +
   Site Verification + Enterprise License Manager APIs on GCP project `leadstart-native-email` (owned by the
   workwithdanielt account — Cloud console `authuser=daniel@workwithdanielt.com`), and set
   `organizations.google_admin_email = daniel@workwithdanielt.com` (via Management API). **Read-only proof:**
   `scripts/probe-google-workspace.ts` — Directory `getDomain(workwithdanielt.com)` → {exists,verified},
   `getUser(daniel@…)` → {exists,not-suspended}. So the scopes, impersonation, APIs, and the src/lib/google
   clients all work against real Google. The Gmail sending domain(s) live on this same Workspace.
1. **Daniel (registrar only — Google is done):** Add Porkbun (+ Spaceship) API keys + the monthly spend cap
   in Settings → Test each; Spaceship needs one saved contact in its dashboard. (Registrar is needed only to
   BUY domains — the provisioning flow runs on already-owned domains without it.)
2. **Claude:** `npx tsx scripts/probe-spaceship.ts` (pins Spaceship shapes); a zero-spend Workspace e2e via
   "Track an existing domain" on a domain Daniel owns; then the first live ~$10 buy **only on explicit
   go-ahead with the $ figure** (inside the $25/mo cap) → verify 3 inboxes land in Mailboxes `warming`.
3. **DONE 2026-08-28:** committed (`2d57e11` + `e603403`) + PUSHED to master (prod deploy). Folded in per
   Daniel's ask: every sending-domain row on Admin → Mailboxes now expands to a DNS panel (expected vs live
   SPF/DKIM/DMARC/MX + registrar read-back). Cron `advance-domain-provisioning` is live but inert (no domain
   in `provisioning` yet).

**Still open:** (a) Daniel's registrar keys (item 1) to enable buying; (b) a first provision test, which
creates REAL Google user seats (~$7-8/mo each until deleted) so it awaits an explicit go-ahead (suggest one
inbox on a throwaway subdomain, then delete); (c) Daniel's visual sign-off on the new Mailboxes UI.

**Standing rules (EMBED):** push to master = instant Vercel **PROD deploy** (this initiative is now pushed);
further changes commit/push only on explicit word. Before push `gh auth switch --user LeadStart`, push, then
switch back to `Kronelius`. Migrations apply via the prod Supabase SQL editor. Get a $ cap before any live
paid registrar run.

---

## 2026-08-27 — Maps DIY prospecting flow: structured-geo + multi-region FOUNDATION SHIPPED; Phases 2–5 remain (autonomous build)

**Goal:** a client-facing, DIY Google-Maps lead-search flow — "customers run their own
search" — as a sequential **cart** experience. This session locked the design (mockups)
and shipped the backend foundation. A fresh session should build Phases 2–5 autonomously.

**SHIPPED to master (commit `deb0642`, live/inert):** [`src/lib/apify/sourcing/maps-search.ts`](src/lib/apify/sourcing/maps-search.ts)
— added `MapsArea` type + `areas` lever + `geoFieldsForArea()` + `buildMapsSearchInputForArea()`
(structured geolocation per area; refactored shared `baseInput`/`applyFilters`). Legacy
`buildMapsSearchInput()` (free-text `locationQuery`) UNCHANGED. Nothing calls the new
builders yet → inert additive. Unit test [`scripts/test-maps-geo.ts`](scripts/test-maps-geo.ts) **26/26**.

**Design LOCKED** (mockups are the visual spec but are **gitignored/local-only** to worktree
`sharp-bouman-213700` — they will NOT travel to a fresh worktree, so THIS spec is the durable source;
if the worktree still exists, read `…/sharp-bouman-213700/mockups/diy-search-walkthrough-directions.html`
and `…/location-picker-directions.html` for fidelity):
- **Shape = "D + running cart".** LEFT column: page header, then a **"Where are your customers?"**
  card (the location picker), then industry chips, then **ready-to-run audience cards** ("+ Add",
  whole card clickable, **no per-card price**). RIGHT column: a **sticky "Your search" cart** that
  **centers vertically in the viewport on scroll** — sections: **Areas (N)** list, **Audiences (N)**
  list, **Enrichment** toggles, **How many leads**, outcome estimate + mix bar, **Run search**.
  Updates are **surgical** (no full re-render / no flash).
- **Location picker = SMART SEARCH (chosen; Daniel confirmed).** One search box → typing shows a
  **grouped, state-qualified disambiguation dropdown** (Cities / Counties / ZIP codes / States) +
  a few **quick-add** chips. Picking a result **ADDS an area** → **multi-region** (Daniel: "there
  must be the ability to add multiple regions"). Each area is a removable chip in the picker and in
  the cart's Areas list. **METRO is removed.** **NO business-count estimates** anywhere (Daniel cut
  them — do not reintroduce "≈N businesses").
- **Actor geo contract** (verified live; encoded in maps-search.ts + tested): city→`city`+`state`+`countryCode`;
  county→`county`+`state`+`countryCode`; state→`state`+`countryCode`; **zip→`postalCode`+`countryCode` ONLY**
  (never city/state/county). Full state NAMES ("Texas", not "TX"). **NEVER emit `locationQuery` with
  structured fields** (the actor's 📍 Location overrides 📡 Geolocation). **One area = one actor run.**
- **Pricing = outcome-tier per DELIVERED lead:** $0.05 record → $0.10 company email → $0.20 owner name
  → $0.30 verified personal email. **Same $/lead regardless of area count** (multi-run cost is our COGS).
- **Veins stay SEPARATE** (Daniel's concern — do NOT conflate): **Maps** = businesses, name-less,
  structured area(s); **LinkedIn** = people, named, ICP filters + multi-location (country/state/city,
  no zip/county). They meet only at enrichment ([`waterfall-routing.ts`](src/lib/enrichment/waterfall-routing.ts),
  name-aware). A **LinkedIn client flow is a SEPARATE future initiative** — NOT part of this build.

**REMAINING — build autonomously, verify each, push as you go (Daniel: "push and keep building"):**
1. **Phase 2 — Cron fan-out + migration.** Rework [`run-maps-searches`](src/app/api/cron/run-maps-searches/route.ts)
   from one-run-per-search → **one run per AREA, sequential**: start area[i] → poll → ingest+accumulate
   → dedupe by `google_place_id` → area[i+1] → when all done, slice to `target_max_results` → complete.
   Per-area cap = `ceil(target / areaCount)` into `buildMapsSearchInputForArea`. Needs a **small migration**
   on `maps_searches` (area cursor + partial accumulation — e.g. `area_index int`, keep partial in `results`
   JSONB). **BACKWARD-COMPAT:** rows with `query.levers.locationQuery` (no `areas`) keep the single-run path.
   *Accept:* unit-test the fan-out/dedup; sandbox-rig e2e (2-area search). **No live paid Apify run without a $ cap.**
2. **Phase 3 — Route + gazetteer.** [`maps-search route`](src/app/api/admin/prospecting/maps-search/route.ts)
   accepts structured `areas: MapsArea[]` (validate; translate state abbr→full name), writes `query.levers.areas`;
   keep the `locationQuery` path for BC. Bundle a **US gazetteer** (counties ~3,143 + states 51, with FIPS +
   abbr↔full name) as a static module (`src/lib/geo/us-gazetteer.*`) for the picker's disambiguation + abbr→name.
   Source: US Census Gazetteer files. *Accept:* route test; gazetteer lookups (Dallas→3 counties, Springfield→3 states).
3. **Phase 4 — Component.** Convert the D+cart mockup to a real React component using the project's UI
   primitives; **match [`maps-search-panel.tsx`](src/app/(dashboard)/admin/prospecting/maps-search-panel.tsx)**
   for polling (`maps-searches/[id]`) + import (`maps-save`). Smart Search picker backed by the gazetteer;
   multi-region areas; audiences (niche packs); add-ons (naming/verify/catch-all); outcome estimate.
   *Accept:* tsc+eslint clean; render-verify via **sidebar client-nav or real Chrome** (hidden-preview deep-route
   rAF hang — [[project_preview_pane_raf_hydration]]).
4. **Phase 5 — Mount it (SURFACE).** **RECOMMENDED: admin Prospecting tab first** — replace/augment the current
   `MapsSearchPanel`, reusing the working `requireEnrichmentContext` auth + backend. **HARD STOP** for the
   **client-portal** version (new `/client` route + client auth/RLS + billing-ledger hooks) — that's the surface
   decision Daniel still owes; build admin-first, leave client-exposure as a documented Phase 6.

**Standing rules (EMBED):** push to master = instant Vercel **PROD deploy** (paying clients) — commit local,
push only on explicit word, per change; **before push `gh auth switch --user LeadStart`, push, then switch back
to the previously-active account (usually `Kronelius`)** — repo is `LeadStart/LeadStart`; a 404 "Repository not
found" = wrong active gh account, not a token issue; git author = LeadStart / daniel@leadstart.io; **MOCKUPS are
gitignored and NEVER committed**; **migrations apply via the prod Supabase dashboard SQL editor** (no local stack)
— write the migration file but the APPLY is Daniel's step; **verify server-side against the SANDBOX Supabase rig,
never prod**; **get a $ cap before any live paid Apify/MV run**.

**Verification state:** Phase-1 foundation `npx tsx scripts/test-maps-geo.ts` **26/26**; pushed clean (identical
base on master, clean rebase). Downstream (Phases 2–5) not started.

---

## 2026-08-26 — A/B auto-winner made OPT-IN + rigorous winner rule (owner-directed); LOCAL-ONLY, awaiting push

Follow-up to the auto-winner entry below, per owner review ("too aggressive; make it
per-node configurable" + "winner determination needs to be better defined"). Two changes:

**1. OFF by default, opt-in.** The auto-winner no longer runs on every A/B test. Resolution:
per-node `EmailNode.ab_config.autoPause` (tri-state: on / off / **inherit**) → per-campaign
`campaigns.ab_auto_pause_default` (migration **00091**, applied) → false. UI: a campaign-settings
toggle (Schedule tab of `campaign-detail-workspace`) + a per-node "Auto-winner" select in the
builder (`flow-editor` `EmailVariants`, shown only on A/B nodes). `resolveAbConfig(node,
campaignDefault)` does the cascade; `evaluateAbWinners` takes the campaign default (read in
`sync-analytics`); the display shows the effective on/off.

**2. Winner rule "better defined"** (owner picked "Significant + real lead"). A challenger is
paused only when ALL hold: ≥30 sends/variant & ≥60 total · leader ≥3 positives · leader leads by
**≥1.0 pt** on positive-reply rate · one-sided two-proportion z-test with a **Bonferroni**
correction across live challengers (3+ variants ⇒ higher bar). Winner is locked only once it has
beaten every rival. Replaces the old bare-significance test (which could crown a trivially-
significant or thin-evidence lead). All six knobs per-node-tunable; `DEFAULT_AB_WINNER_CONFIG`
= autoPause:false · 30/60 · 3 positives · 1.0pt · 95%.

**Storage note (why a migration this time):** the per-node flag rides in `flow_graph` JSONB (no
migration), but the per-campaign DEFAULT is a first-class campaign setting saved through
`update-sequence` alongside `daily_new_leads_cap`/`sending_strategy` — so it's a campaign column.
Migration 00091 = `campaigns.ab_auto_pause_default boolean not null default false` (additive,
idempotent, applied to prod ahead of the push like 00089/00090).

**Verification:** tsc clean (0 new; 19 pre-existing) · eslint clean · unit **213** (ab-winner 57,
flow-variants 36, ab-results-render 16, runtime 63, progress 18, graph 13, edit 10) · live-DB e2e
`e2e-ab-winner.ts` **13/13** — proves off-by-default, the campaign-default column round-trip +
inheritance, the pause write/JSONB round-trip, sender exclude/sticky, save-preserve, idempotency
(self-cleaning draft, `.invalid` emails, zero spend). Builder select + settings toggle are
tsc+eslint-verified; live visual sign-off defers to post-deploy (deep campaign route is
rAF-hang-flaky in the hidden preview — [[project_preview_pane_raf_hydration]]).

**Deploy note:** migration 00091 is live; the code is local. The column defaults false, so even
post-deploy nothing auto-pauses until someone turns it on (campaign settings or a node). Everything
below in the prior entry still applies.

---

## 2026-08-26 — A/B AUTO-WINNER: significance-test auto-pause of losing variants; LOCAL-ONLY, awaiting push

Built on top of the A/B stack below (which is itself awaiting the same push). Once a
variant gathers enough sends, a **one-sided two-proportion z-test on positive-reply rate**
auto-pauses the losers so NEW leads route to the leader. **No migration** (pause flag lives
in the graph JSONB). Living tracker: [`docs/plans/campaign-editor-roadmap.md`](docs/plans/campaign-editor-roadmap.md) §4.

### What changed (6 concerns)
1. **Pure decision** — `src/lib/flow/ab-winner.ts`: `decideAbWinner(stats, config)` (z-test;
   critical z from an Acklam probit; monotonic — only adds pauses, never pauses the leader or
   the last active variant; degenerate SE → no pause). `DEFAULT_AB_WINNER_CONFIG` = 30
   sends/variant · 60 total · 95% one-sided; per-node override via `EmailNode.ab_config`. Plus
   pure graph merges `mergePausedIntoGraph` (union new pauses) + `mergeStoredPauses` (save-route preserve).
2. **Pause storage** — `EmailNode.paused_variant_ids: string[]` (JSONB, additive, **no migration**);
   `emailVariants` annotates `ResolvedVariant.paused`; new `activeVariants` helper.
3. **Sender read-side (minimal, low deploy-risk)** — `pickVariant(node, id, {assignedId})` EXCLUDES
   paused for new leads, STICKY to a recorded assignment; a per-tick prefetch of each contact's
   first-email `variant_id` keeps a follow-up "Re:" subject on the variant they actually got. The
   sender does NO stats + NO writes — it only reads the flag.
4. **Evaluator OFF the hot-path** — `src/lib/flow/ab-winner-eval.ts` `evaluateAbWinners`, called
   from the **hourly `sync-analytics` cron** on the send log + replies it already pages (no extra
   fetch, cheap early-out unless the graph has an A/B node). Merge-safe write: re-read fresh graph →
   union pauses → persist only if grown; touches only `flow_graph`. Returns `variants_paused` in the response.
5. **Save-route preserve** — `update-sequence` re-applies stored pauses onto an incoming graph
   (`mergeStoredPauses`), so a manual builder edit can't wipe an auto-pause (a stale builder that
   loaded before the pause would otherwise clobber it).
6. **Display** — `ab-results.tsx`: Winner (trophy) + Paused (amber) + provisional Leading badges;
   `computeVariantStats` now exposes per-variant `paused` + `winnerId`/`decided`.

### Verification
tsc clean (0 new errors; 19 pre-existing) · eslint clean on touched files · unit **190**
(ab-winner 41, flow-variants 33 [+14], ab-results-render 12, runtime 63, progress 18, graph 13,
edit 10) · **live-DB e2e 10/10** (`scripts/e2e-ab-winner.ts` — real native_sends + lead_replies drive
the REAL evaluator → pause written to flow_graph + round-trips JSONB → sender pickVariant excludes/sticky
→ mergeStoredPauses preserves → idempotent second pass; self-cleaning DRAFT, `.invalid` emails, zero spend).
Display verified via static-markup render (deep campaign route is rAF-hang-flaky in the hidden preview — [[project_preview_pane_raf_hydration]]).

### Deploy risk (same gate as the stack)
Push auto-deploys, no staging. Sender change is a READ + prefetch only (flow campaigns; legacy byte-identical).
The evaluator is isolated in the hourly analytics cron — a bug there cannot stop sends. In production the
default config (30/60/0.95) means a pause only fires after real volume; low positive-reply rates mean many
campaigns never auto-pause (correct — never call a winner without evidence). Post-deploy: watch a live A/B
campaign's `sync-analytics` response for `variants_paused` once a node crosses threshold.

**Open follow-ups (not blocking):** (a) a builder "reset A/B test" affordance to manually un-pause
(today pauses are monotonic + server-owned); (b) optional per-node `ab_config` editor UI (field + eval
wired, no UI yet); (c) send-time "risky/paused last" ordering is unrelated (that's the catch-all item).

---

## 2026-08-26 — Campaign-editor stack: reply-class conditions + flow observability + A/B testing; LOCAL-ONLY, awaiting push

Three stacked builds on top of the (now-pushed) #3 graph runtime, same worktree/branch
`claude/graph-runtime-phase3`. Committed LOCAL-ONLY; **awaiting the owner's push.**
Living tracker: [`docs/plans/campaign-editor-roadmap.md`](docs/plans/campaign-editor-roadmap.md).

Owner direction this session: dropped open/click tracking as a dead end (we never add
tracking pixels/links — deliverability), so conditions/A/B/analytics all run on **inbound**
signals (replies + class, bounces). Unipile stays parked (LinkedIn = manual VA tasks).

### 1. Reply-class conditions
Flow conditions can branch on the reply's **sentiment**, not just "did they reply." New
triggers `reply_interested | reply_objection | reply_not_interested | reply_ooo` route on
`lead_replies.final_class` (sentiment groups — mapping in the roadmap doc). `replied`/`bounced`
stay; `opened`/`clicked`/`manual` **retired** from the builder (kept legacy-safe → NO branch).
Runtime `matchedReplyRoute`: a matching reply-condition stands the global reply-halt down, but
an **unhandled** reply class still halts (never re-email a replier). **No migration.**

**OOO fix (post-push, commit after the stack):** `hasReplied` (the halt signal + the plain
`replied` trigger) keys on `contact.status==='replied'` ONLY — which the reply poller sets
just for HUMAN replies (it deliberately skips out-of-office/auto-replies). An OOO still writes
a `lead_replies` row, so `replyClass='ooo'` drives `reply_ooo` (route it — e.g. wait + resume)
without halting. The earlier "contact.status OR a lead_replies row" signal wrongly halted flow
sequences on an OOO (auto-reply); linear campaigns were never affected. Runtime 63/63.

### 2. Flow observability
Read-only **"Flow progress"** view on the campaign Analytics tab: per-node live occupancy
("N here"), each condition's Yes/No branch split, and a rollup (enrolled/active/peeled/
completed/failed + reply & positive-reply rates). Derived from `current_node_id` +
`lead_replies.final_class` — **no migration**. Legacy/linear campaigns keep the linear funnel.

### 3. A/B (and C/D…) testing
`EmailNode.variants` (JSONB, backward-compatible — variant A = the node's own subject/body).
Migration **00090** = `native_sends.variant_id` (applied). The sender assigns each contact a
variant **deterministically** (even, sticky, no stored state) and stamps `variant_id`; the
Analytics tab shows a per-variant table (sent / reply / positive-reply rate) with the leader
flagged. Measured on inbound outcomes only. Builder gets an "Add variant" editor per email node.

### Verification
tsc clean · unit **96/96** (runtime 59, progress 18, variants 19) · e2e **11/11** (live DB,
self-cleaning draft) · **browser-verified**: the builder (reply-class picker + A/B editor +
honest starter) rendered live; FlowProgress + AbResults verified via SSR on a seeded draft
(real numbers — Enrolled 6/Active 4/Peeled 1, reply 33.3%/positive 16.7%; variant A 66.7%
reply vs B 0%) then cleaned up. Migrations applied: 00089 (#3), 00090 (A/B).

### Deploy risk (same gate as #3)
Push auto-deploys with no staging. Reply-class + A/B only affect **flow campaigns** (legacy
byte-identical). The sender change is small (variant pick + variant_id stamp; reply-class
routing already gated behind flow_graph). The Analytics additions are read-only. Validate
post-deploy on a controlled flow campaign.

---

## 2026-08-26 — #3 GRAPH RUNTIME built + verified + migration applied; LOCAL-ONLY, awaiting the push

The native sender now EXECUTES `campaigns.flow_graph` (branches + linkedin +
internal nodes run), not just the derived linear steps. Built in worktree
`.claude/worktrees/graph-runtime-phase3` on branch `claude/graph-runtime-phase3`.
**Committed locally, NOT pushed** — pushing rewrites how live campaigns send (no
staging); owner validates post-deploy on a controlled campaign.

### What changed
- **Migration `00089`** (APPLIED to prod 2026-08-26): `campaign_enrollments.current_node_id text`
  (nullable, additive). The enrollment's position INSIDE the graph. Legacy/linear
  campaigns (`flow_graph` NULL) ignore it and keep using `current_step_index` — zero regression.
- **`src/lib/flow/runtime.ts`** — the PURE walker `resolveFlowAction(graph, position, signals)`:
  resume after `current_node_id`, accumulate wait days, route conditions, return the
  next actionable node (email/linkedin/internal) or `complete`. Lazy re-eval each tick
  so a mid-wait reply re-routes. Unit-tested 39/39 (`scripts/test-flow-runtime.ts`).
- **`run-native-sequences/route.ts`** — a flow branch (`runFlowEnrollment`) walks the
  graph; email → shared `dispatchEmail` (the linear send block was refactored onto the
  SAME helper — one send path, no drift), linkedin → `createManualTask` (session C),
  internal → `runInternalNode` (session B). A per-tick action budget bounds side-effects.
- **`flow-editor.tsx`** — a "needs tracking" note on opened/clicked/manual conditions
  (no signal → they take the NO arm at runtime; the YES arm won't fire).

### Condition semantics (PRE-DECIDED, implemented)
- `replied` → yes iff `contact.status==='replied'` OR a `lead_replies` row (campaign+email); else no.
- `bounced` → yes iff `contact.status==='bounced'`; else no.
- `opened`/`clicked`/`manual` → **always NO** (open/link tracking off by default; no signal). Fail-safe: never peel on an unmeasurable signal; flagged in the builder.
- Global reply-halt reconciliation: on an email action, if the contact replied and NO
  replied-condition was traversed to reach it → halt (status='replied'), same as today.
  If a replied-condition governs, the walk already routed (yes arm) — no pre-empt.
- `current_step_index` keeps counting EMAILS for flow campaigns too (0=first touch), so
  the send machinery (subject/threading, new-leads cap, sticky mailbox) is unchanged.
- Pre-migration in-flight flow enrollments (current_node_id NULL, step>0) resolve their
  resume node from `current_step_index` → NO re-send.

### Verification
- tsc clean (0 new errors in touched files; the 26 remaining are the documented
  pre-existing strict-null/asset-import pages). Unit 39/39. e2e 11/11 against the LIVE DB
  on a self-cleaning DRAFT campaign (`scripts/e2e-flow-runtime.ts`): flow_graph JSONB
  round-trip, real signal read, routing both arms, real `manual_tasks` insert + flow_node
  dedup, cleanup verified (0 orphans).

### Deploy risk (the one gate)
- Push auto-deploys; the sender's per-tick behavior changes for **flow campaigns only**.
  In-flight flow enrollments will start executing previously-skipped condition/linkedin/
  internal nodes (LinkedIn tasks appear in the to-dos inbox; internal notifies fire only
  if an org enabled automations — OFF by default). Legacy/linear campaigns: byte-identical.
- Post-deploy validation: a controlled flow campaign with a branch, watch routing + tasks.

---

## 2026-08-26 — Flow builder shipped; internal-automations (B) + LinkedIn VA-tasks (C) MERGED; #3 (graph runtime) is next

### Shipped & deployed to prod (master @ `778b97c`)
- **Visual Flow campaign builder** (Instantly-style tabbed workspace + branching sequences). Model in [`src/lib/flow/graph.ts`](src/lib/flow/graph.ts) (node kinds email/wait/linkedin/internal/condition; conditions have `yes[]`/`no[]`). `graphToSteps()` derives the linear `campaign_steps` the native sender runs. Persistence: `campaigns.flow_graph` JSONB (migration `00086`, applied). Tests: graph 13/13, edit 10/10.
- **Session B — internal automations** (merged `9377535`): org notify config (`organizations.automation_settings` JSONB, migration `00087` applied) + reply-triggered Slack/webhook/email from the reply pipeline. Delivery helper: `src/lib/notifications/internal-automations.ts`; settings: `src/lib/automations/settings.ts`. **OFF by default.**
- **Session C — LinkedIn VA-tasks** (merged `f094aed`): `manual_tasks` table (migration `00088` applied, RLS + 4 policies + 6 indexes) + "LinkedIn to-dos" admin inbox + `createManualTask` helper (`src/lib/manual-tasks/create.ts`).
- `UNFAIR-ADVANTAGES.md` — self-serve strategy doc (flagship: 30-day pre-send re-verification).

> **KEY FACT:** the sender (`run-native-sequences`) still runs ONLY the derived **linear email steps**. Condition / linkedin / internal nodes are authored + persisted (and B's/C's *surfaces* are live) but the nodes **DO NOT EXECUTE** yet. #3 wires that up.

### Next — Session #3: graph-executing runtime + branch execution (migration `00089`), SOLO, autonomous
Makes `run-native-sequences` walk `flow_graph` instead of the flattened linear steps; changes `campaign_enrollments` position from `current_step_index` → a node id; executes conditions (branch), calls B's delivery helper at internal nodes and C's `createManualTask` at linkedin nodes; legacy linear campaigns unchanged. Designed to run continuously to a committed, locally-verified state, stopping ONCE for the deploy sign-off (pushing rewrites how live campaigns send; no staging).

**Paste-in kickoff prompt** (fresh worktree off master):

```
Start the graph-runtime phase (#3) of the LeadStart Flow campaign builder (Next.js 16, Supabase, native Gmail-API sender) in a FRESH worktree off master. Run this END-TO-END autonomously: work continuously in one pass, self-verify at each step, DON'T stop to ask about interim decisions and DON'T loop/wait. Stop only ONCE, at the very end, for deploy sign-off (see THE ONE GATE).

First: session-start sync (git pull origin master; confirm up to date; git log -5). Read HANDOFF.md (top entry), src/lib/flow/graph.ts, src/lib/flow/edit.ts, src/app/api/cron/run-native-sequences/route.ts, PROJECT_STATUS.md. Then read the two merged helpers you'll wire into and use their REAL signatures: src/lib/notifications/internal-automations.ts + src/lib/automations/settings.ts (session B — internal notify/webhook delivery) and src/lib/manual-tasks/create.ts (session C — createManualTask).

State: A sequence is a FlowGraph (kinds email/wait/linkedin/internal/condition; conditions have yes[]/no[]) in campaigns.flow_graph. TODAY the sender runs only the derived linear campaign_steps (graphToSteps) and ignores non-email nodes. Migrations 00086/00087/00088 are applied to prod; B & C surfaces are merged + deployed but their execution hooks are unwired.

Task — make the sender execute the flow graph (migration 00089):
1. Enrollment position: add current_node_id (+ any path state needed) to campaign_enrollments (migration 00089). Feature-detect: campaigns with flow_graph=null keep EXACT current linear behavior (current_step_index) — zero regression.
2. Rewrite run-native-sequences to walk flow_graph from each enrollment's node: email → send (unchanged mechanics: window, warmup caps, verification gate, DNC/suppression, threading, strategy ordering); wait → gate on wait_days from last_action_at; condition → evaluate + branch (see #3); linkedin → call C's createManualTask then advance; internal → call B's delivery helper for that node then advance. One node per due tick; cadence self-heals (waits measured from previous send).
3. Condition semantics (PRE-DECIDED — implement, do not ask): evaluate at the node against real signal. `replied` = contact replied (contact.status==='replied' or a lead_replies row for this campaign+contact) → yes, else no. `bounced` similarly. `opened`/`clicked` have NO reliable signal (open/link tracking OFF by default) → take the NO/continue branch (fail-safe) and flag those triggers "needs tracking" in the builder. Reconcile with the existing global reply-halt: a path with NO downstream reply-condition keeps halting on reply as today; a replied-condition routes instead of halting. Document the rules in a comment + final report.
4. Keep graphToSteps + all legacy linear campaigns behaviorally unchanged.

Verify autonomously before the gate: unit-test the graph walker as a PURE function (graph + position + reply/bounce state → next action) covering both branches of a top-level AND nested condition, wait gating, internal/linkedin side-effects, and the legacy-linear path. Then a light e2e: create a throwaway DRAFT campaign with a branched flow_graph, drive the LOCAL cron, confirm routing + a manual_tasks row is created + the internal helper would fire; then DELETE the draft. IMPORTANT: prod's Vercel cron ticks the SAME DB every 5 min with the OLD linear code — do NOT activate a test campaign prod could grab, don't trust send-count deltas, lean on unit tests. tsc must be clean.

Standing rules: LOCAL-ONLY. Apply migration 00089 via scripts/supabase-sql.mjs (Management API; SUPABASE_ACCESS_TOKEN in .env.local) AFTER a pre-flight existence check + showing the SQL; keep it additive/idempotent (ADD COLUMN IF NOT EXISTS). Commit locally, split by concern, author LeadStart <daniel@leadstart.io>. Rebase on origin/master before the gate if master moved.

THE ONE GATE: do NOT push/deploy. Pushing to master auto-deploys and this rewrites how LIVE campaigns send (no staging). When it's built, unit-verified, migration applied, and committed locally, STOP and report: what changed, your condition-semantics rules, the verification evidence, and the exact deploy risk — then wait for my explicit "push". Live validation happens post-deploy on a controlled campaign.
```

### State snapshot
- Branch `claude/campaign-builder-redesign-b4e24f`, worktree `.claude/worktrees/intelligent-wilbur-6fe08f`. HEAD = origin/master = `778b97c`, clean.
- Migrations applied to prod: `00086` (flow_graph), `00087` (automation_settings), `00088` (manual_tasks). Next free number: **`00089`** (owned by #3).
- B & C feature worktrees (`internal-automations-setup-9d84fc`, `linkedin-manual-va-tasks-6c0dd0`) are merged; safe to remove.
