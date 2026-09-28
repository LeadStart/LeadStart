# HANDOFF — LeadStart

> Rolling session-continuity log. Newest entry on top. Roll old entries to
> `HANDOFF_ARCHIVE_<period>.md` once this passes ~60 KB.
> Rolled so far: [`HANDOFF_ARCHIVE_2026-08.md`](HANDOFF_ARCHIVE_2026-08.md) (entries 2026-08-26 to 2026-08-29).

---

## 2026-09-27: Add inboxes to already-set-up domains + hard cap of 3 inboxes per domain (pushed to master)

**Why.** Daniel couldn't add an inbox: the wizard's "Use existing" list only showed never-set-up domains and `POST /api/admin/domains/[id]/workspace` refused anything else, so a set-up domain could never get another Google inbox in-app. Diagnosis also found both TuBe domains EMPTY: the 6 Google users provisioned 2026-08-31 (daniel / danielt / danieltuccillo @tubeforseo.com, mike / mikebennett / mbennett @gettubeseo.com) and their `native_mailboxes` rows were deleted before ~09-07 (not restorable; who/how unknown; the only in-app Google-user delete is the Mailboxes trash button). Both domains are warming with DKIM live (Daniel generated gettubeseo.com's DKIM; it flipped to warming 2026-09-28 02:17 UTC). Owner rule: everything must be doable inside LeadStart.

**What shipped** (`ff695bd`, `e8bdffb`, docs in the commit after them):
- `inboxSetupEligibility(domain, inboxCount)` (pure, `src/lib/deliverability/provisioning.ts`): `setup` / `add_inboxes` / refused with an owner-facing reason. Shared by the wizard, the domain rows and the route.
- `add_inboxes` provisioning run (`initAddInboxesState`, `kind: "add_inboxes"`): the domain steps are pre-completed. DNS is never rewritten; Workspace membership is checked LIVE via Directory `domains.list` (`domains.get` answers 403, not 404, for a domain owned by another Google account); verification is pre-marked when the Directory says verified; DKIM is watched only while the domain is still in provisioning. The runner's DKIM step no longer claims a warming flip for a domain that already sends.
- `GET` + `POST /api/admin/domains/[id]/workspace` handle both kinds (GET = the wizard's preflight); names that are already inboxes are refused. The `advance-domain-provisioning` cron also advances unfinished add-inboxes runs on warming/active domains.
- UI: every eligible domain row has **Set up inboxes** / **Add inboxes**, both opening the one wizard at the Workspace step (the old duplicate `domain-setup-modal.tsx` is deleted). "Use existing" lists every Google domain, greyed out with the reason when it can't take inboxes; the Workspace is locked for a domain already set up on one; Review says "No DNS changes"; the seat-cost line reads "~$8/mo" for one seat (was "$8–8").
- **Hard cap: 3 inboxes per domain** (`MAX_INBOXES_PER_DOMAIN`, owner rule 2026-09-27), enforced in the wizard, the setup route (existing + new) and the connect route (`POST /api/admin/mailboxes`). Replaces the old warn-above-3, allow-up-to-10 behavior.

**Verification.** tsc 0 errors; eslint clean; `scripts/test-provisioning.ts` 117/117 (62 new). In the local app against live data: all 5 domain rows show Add inboxes; the live preflight passes tubeforseo.com, gettubeseo.com and workwithdanielt.com and refuses davidcabreraproperties.com + getiniciopropertysolutions.com (client-owned Google accounts, not on the Main Workspace) with an actionable reason; the wizard walked to Review for tubeforseo.com (Create NOT clicked); the cap stops the name rows at 2 new for workwithdanielt.com and 3 for tubeforseo.com. Rebased onto `46873f0` (mailbox signature/identity) with no conflicts; `scripts/test-tokens.ts` 47/47 after the rebase.

**Live proof (same night):** Daniel created 3 inboxes on gettubeseo.com with Add inboxes; the `add_inboxes` run completed 2026-09-28 04:11 UTC (3 Google users created and registered, DNS untouched, domain steps pre-completed). The route's duplicate-name and cap refusals are still verified by code reading only: the live POST test was blocked by the session's safety check as a production write.

**Follow-up (same night, `9387a11`, `a8c1913`):** he then couldn't find where to edit an inbox's signature or warmup. The identity panel from `46873f0` (name + signature) only opened from the health score, which a new inbox doesn't have, or the "Not tested" text. Now every inbox row has a **Signature & warmup** chip under its address (always on screen; the Actions column scrolls off on narrow windows) plus a pencil in Actions. The panel ("Identity and warmup") adds a per-inbox **Ramps up to** cap (`max_daily_cap`, 1 to 20) and states the fixed cadence (5/day, +1 a day as it actually sends); a ramp-bypassing `daily_cap_override` is only shown and cleared there, never set (none is set today). The stray "," in the Health column for new inboxes (left by the 2026-09-05 em-dash sweep, `9f920dd`) now reads "Pending"; two more stray commas (billing invoices table, sparkline) are queued as a separate task.

**Next pickup:**
- Daniel: add inboxes to tubeforseo.com (still 0) from its **Add inboxes** (up to 3; paid Google seats at the app's own ~$7.50-8.40/seat/mo estimate, not checked against Google's pricing), and set a signature on each new inbox via **Signature & warmup** (none of the 8 inboxes has one yet, so `{{signature}}` prints the name alone).
- David Cabrera / Inicio domains: adding inboxes needs that client's Workspace added in the wizard's Workspace step AND their admin authorizing LeadStart's service account in their Google Admin.
- HANDOFF rotated in this change: the 9 oldest entries (2026-08-26 to 2026-08-29) moved verbatim to `HANDOFF_ARCHIVE_2026-08.md`.

---

## 2026-09-24: David Cabrera — deleted 57 no-first-name contacts (data-op, prod) + card shows true totals (pushed to master)

**Delete:** the CSV had 57 rows with blank first AND last name (blank at source, verified: `David_Cabrera_Agent_Recruiting_consolidated_deduped.csv` has exactly 57 blank-first-name rows; 0 blank email/address). Per owner, removed rather than emailed with a fallback. Ran `scripts/delete-david-noname-contacts.mjs --apply` (backup-first, dry-run default, cascades to campaign_enrollments; verified 0 sends/replies on the 57 so no history lost). Result RECONCILED: 57 contacts removed, campaign 2652 → **2595 assigned / 2595 enrolled**. Reversible backup: `C:\Users\danie\Documents\Clients\David Cabrera\noname-contacts-delete-backup-2026-09-24T18-39-51-719Z.json`.

**Card true totals:** extended the display-fix so the Contacts card headline shows exact campaign-wide counts (assigned = exact count query, in-sequence = paged enrollment count) instead of the row-capped "1000+". Threaded `assignedTotal`/`enrolledTotal` through `page.tsx` → `campaign-detail-workspace.tsx` → `campaign-contacts-card.tsx`. tsc clean. Pushed to master 2026-09-24.

## 2026-09-24: Campaign detail page — 1000-row PostgREST cap fix (pushed to master 2026-09-24)

**Symptom:** after a large CSV import, David's campaign Contacts tab read "1000+ assigned · 8 in the sequence · 992 not enrolled" although all 2,652 contacts were enrolled and sending. The page's "Active/Completed" stat line, funnel, verification breakdown, flow-progress and A/B numbers were undercounted the same way.

**Root cause:** several `.from(...).select(...).eq("campaign_id", ...)` fetches on the campaign detail page pull "all rows" with no `.range()`, and PostgREST caps un-ranged responses at 1000 rows (`Content-Range: 0-999/2652`). Anything computed from the truncated set (enrollment map, sent/enrolled tallies, per-step buckets) was wrong once a campaign crossed 1000 enrollments/sends. David's is the first campaign past 1000.

**Fix:** new helper `src/lib/supabase/fetch-all.ts` (`fetchAllRows`, pages via `.range(from, from+999)`, mirrors the cron routes' existing idiom). Applied in `src/app/(dashboard)/admin/campaigns/[id]/page.tsx` to: the card enrollment map, `nativeStatsFor` (sends + enrollments + per-mailbox sends), flow-progress (enrollments + replies), and A/B sends. `campaign-contacts-card.tsx` subtitle now flags the enrolled count as truncated ("1000+ in the sequence") to match the assigned "+".

**Verified:** tsc clean on the changed files; paginated fetch returns all 2,652 enrollments; card-logic simulation flips from capped (wrong) to paged = 1000 enrolled / 0 not-enrolled. Pushed to master 2026-09-24 (prod auto-deploys).

## 2026-09-24: David Cabrera campaign "0 contacts" — campaign_id backfill (data-op, LOCAL script, prod data write)

**Symptom:** David Cabrera — Buyer Agent Outreach (campaign `f9c179e6-799d-44f4-8753-806fcc1c2b83`, native_email, active) showed "0 assigned · 0 in the sequence" on the Contacts tab while actively sending (2,712 native_sends, last send that day).

**Root cause (verified):** the campaign was built by `scripts/build-david-cabrera-campaign.mjs`, which inserts contacts with `campaign_id: null` (line 408) and enrolls them directly into `campaign_enrollments` (lines 485-495). The Contacts tab counts `contacts.campaign_id` (assignment); the dispatcher sends off `campaign_enrollments` (enrollment). The two are separate, so sending worked while the tab read 0. NOT a bug in the in-app CSV importer (`/api/campaigns/[id]/client-import` sets campaign_id on both insert and link).

**Fix:** backfilled `contacts.campaign_id` = campaign for the 752 enrolled-but-unassigned contacts via `scripts/backfill-david-campaign-id.mjs --apply` (Management API). Display-only; verified read-only that neither run-native-sequences nor poll-native-replies reads `contacts.campaign_id`.
- Backup (pre-op, 752 rows): `C:\Users\danie\Documents\Clients\David Cabrera\campaign-id-backfill-backup-2026-09-24T18-00-49-058Z.json`. Rollback = set campaign_id=null for those ids.
- Result RECONCILED: assigned 0 → 752, enrollments unchanged 752, target remaining 0.
- Script is LOCAL/uncommitted (per no-commit policy). Idempotent; re-run touches 0 rows.

**Still open (not actioned):** David's client holds only 752 contacts, all from the 2026-07-05 build. The 2026-09-23 weekly pull of 2,653 unique agents (in `C:\Users\danie\Documents\Clients\David Cabrera\`) was never imported. Importing via the in-app importer (not the script) would refill the campaign AND avoid recreating the campaign_id-null gap.

## 2026-09-05: Native send + cron runtime audit (Tier 1 + Tier 2) — 9 commits PUSHED to master 09:43Z (deployed)

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

**Commits (pushed to master 2026-09-05 09:43Z, auto-deployed):** `9dbae48` cron fleet, `96c448d` send
runtime + Gmail client, `7bed81c` reply poller + MIME, `75a6bef` small items,
`43e5031` error boundaries, `f9d9536` tsc to zero + `ignoreBuildErrors=false`
(build passes twice), `d7081f1` migration 00126 RLS delta (NOT applied), plus the
docs commit. Verified: tsc 0 errors, six test suites green (23/39/42/27/11/46),
MIME probe re-run, `npm run build` green.

**For Daniel:**
1. Pushed on Daniel's "push it". After the first production tick, check the cron
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
