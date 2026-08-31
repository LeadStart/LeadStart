# Deliverability Infrastructure Plan

> Drafted 2026-08-26. Local doc, not pushed.
> Scope: self-hosted SMTP sending tier, automated Google Workspace inbox provisioning,
> registrar (domain-purchase) automation, and — the spine of the whole thing — a
> domain/mailbox lifecycle system whose job is to make sure we never burn a domain.
>
> **Status: Burn-prevention CORE COMPLETE, BUILT LOCALLY (not pushed); migrations
> 00081/00082/00083 APPLIED to prod 2026-08-26.** The full core — domain substrate,
> health rollup, lifecycle cron, fast circuit breaker, and per-domain cap — is built and
> verified (tsc-clean; 88/88 lifecycle unit tests). Lifecycle automation ships gated
> OFF (`organizations.domain_lifecycle_enabled`, migration 00082): it observes and reports
> until armed. Added since the first pass: the `manage-mailbox-lifecycle` cron (§8), the
> bounce circuit breaker in `poll-native-replies`, and the optional per-domain daily cap
> (`sending_domains.max_daily_sends`, migration 00083). Details below.
>
> **First-pass status (superseded above): Phase 1 substrate; migration 00081 APPLIED to prod
> 2026-08-26.** Landed (tsc-clean, 64/64 lifecycle unit tests): migration `00081`
> (`sending_domains` + `native_mailboxes.domain_id`/`ramp_baseline_sent` + `provider`
> CHECK widened to `smtp` + backfill — **applied & verified live**: 3 domains, 5 mailboxes
> linked, 0 mismatched); the `SendingDomain`/`DomainLifecycle` types; the pure lifecycle
> module `src/lib/deliverability/lifecycle.ts` (state machine + circuit-breaker predicate +
> timers + `nextWatchStreak`); two behavior-preserving dispatcher wirings (ramp-reset offset;
> step-0 drain filter); and the **domain health rollup** in `check-inbox-health` (worst-member
> score + daily watch-streak → `sending_domains`, reconciled against live scores). Remaining
> Phase-1 items (circuit-breaker WIRING, per-domain cap, auto-pause arming) in §4. Phases 2–6
> unstarted.

---

## 1. Goal

Two sending tiers, one lifecycle system:

| Tier | Infrastructure | Cost/inbox | Carries | Deliverability |
|---|---|---|---|---|
| **Gmail** (exists today) | Google Workspace + Gmail API | ~$7–8.40/mo (seat) | Verified-`ok` recipients only | Premium — protect at all costs |
| **SMTP** (new) | Hetzner VPS + Mailcow, our IPs | ~$1/mo all-in | `catch_all` / `unknown` recipients (risk tier) | Disposable by design — rotate, rest, reuse |

Everything below extends primitives that already exist and work: the ramp-as-data warmup
([src/lib/gmail/ramp.ts](../../src/lib/gmail/ramp.ts)), the 9-component inbox-health score
([src/lib/deliverability/inbox-health.ts](../../src/lib/deliverability/inbox-health.ts)),
seed placement tests (migration 00068), and the Million Verifier pre-send gate
([src/lib/millionverifier/policy.ts](../../src/lib/millionverifier/policy.ts)).

**Operating principles (locked):**
- One sender per prospect. Failover mid-sequence is allowed only at step boundaries for
  NEW enrollments; sticky threading on in-flight enrollments is never broken.
- No duplicate sends to the same recipient from multiple inboxes — ever.
- No warmup pools / fake engagement (standing owner decision). Warming = ramped volume of
  real verified sends at a steady cadence, measured by seed placement tests.
- No aged/expired domain purchases. Fresh registrations or our own rested stock only.
- `invalid` / `disposable` recipients are never sent to from any tier (current policy, unchanged).
- The 20/day `ABSOLUTE_MAX_DAILY_CAP` per inbox stays the hard ceiling on both tiers.
- Rotate at **tired**, never at dead. A domain that reaches "burned" is a system failure,
  not a lifecycle stage we plan to visit.

---

## 2. The burn-prevention spine

This is the part that must exist before any new inbox is created. Today's gaps, per the
architecture survey (2026-08-26):

1. **Domains are not entities.** Health, DNS checks, pauses, and status are all
   per-mailbox (`native_mailboxes`). There is nowhere to say "this domain is tired,"
   "rest until October," or "pause the whole domain." SPF/DKIM/DMARC/MX/DBL lookups are
   also re-run redundantly per mailbox on the same domain every hourly health tick.
2. **Auto-pause is opt-in and currently OFF.** `organizations.inbox_health_offline_threshold`
   is NULL (alert-only). The mechanism is built and safe (needs two consecutive
   sub-threshold checks); it just isn't armed.
3. **The ramp can't reset.** `effectiveDailyCap()` keys on all-time send count from
   `native_sends` — a rested mailbox would come back at full cap instead of re-warming.
4. **No fast circuit breaker.** The health score's bounce component looks at a 7-day
   window and runs hourly; a poisoned list can do a day of damage before anything reacts.

### Guardrail table (the target state)

| Signal | Threshold | Automatic action | Where |
|---|---|---|---|
| Health score (existing 9-component) | `< 50` (critical), 2 consecutive checks | Pause mailbox (existing auto-pause, armed) | `check-inbox-health` — **config change only** |
| Health band | `watch` for 3 consecutive daily rollups | Domain → **tired** (drain mode) | New lifecycle cron (Phase 5) |
| Seed placement test | any `spam_count > 0` on latest complete test | Domain → **tired**; alert | Lifecycle cron |
| Seed placement test | majority spam | Domain → **resting** immediately (skip drain) | Lifecycle cron |
| Hard bounce, fast window | ≥3 hard bounces in trailing 24h **or** >5% of last 20 sends | **Circuit breaker**: pause domain intake same tick; alert | `run-native-sequences` (new) |
| Spamhaus DBL listing (domain) | listed | Pause all sending on domain immediately; attempt delist; if listed after rest → **burned** | Health cron (exists) + lifecycle cron |
| IP blacklist (SMTP tier) | listed | Pause all domains on that IP; alert | Health cron (new IP check) |
| MV verifier outage / no credits | — | Hold unverified sends (fail-closed — exists, unchanged) | MV gate |
| Domain age | < 21 days since DNS live | Domain cannot leave **warming** regardless of ramp position | Lifecycle rules |
| Per-domain daily volume | > sum of its mailboxes' ramp caps (defense-in-depth) | Skip sends over cap | `run-native-sequences` (new) |
| Reserve pool depth | warming+ready inboxes < target | Auto-provision (SMTP tier) / provisioning checklist (Gmail tier); alert | Lifecycle cron |

**Lifecycle state machine** (on the new `sending_domains` table):

```
provisioning → warming → active → tired → resting → (re-)warming → active …
                                    ↓         ↓
                                 burned ← (still bad after rest)
                                    ↓
                                 retired (terminal)
```

- **provisioning**: bought, DNS being written, DKIM pending. Not sendable.
- **warming**: mailboxes ramping (5→20 Gmail / 3→15 SMTP). Sendable at ramp caps.
  Exit requires: ramp graduated AND ≥21 days old AND latest placement test clean.
- **active**: full duty. Health rollup monitored daily.
- **tired**: **intake closed** — no new step-0 enrollments assigned to its mailboxes;
  sticky in-flight follow-ups continue (threading + SPF alignment preserved). After the
  drain window (default 14 days — the longest follow-up tail) → resting.
- **resting**: all mailboxes paused, MX + DNS stay live so late replies still arrive
  (reply poller keeps polling). Default 45 days (owner-tunable 30–90).
- Rest complete → re-enters **warming** with a **ramp reset** (see `ramp_baseline_sent`
  below) and a fresh placement probe before it may re-enter active.
- **burned**: DBL-listed or still spamming after a full rest. Never reused. Alert to
  replace. **retired**: manually ended (domain not renewed).

---

## 3. Phase 0 — Owner decisions & prerequisites (Daniel)

> **DECIDED 2026-08-26:** Registrar = **BOTH Porkbun + Spaceship** (buy where cheaper).
> Monthly domain spend cap = **$25/mo** (fail-closed; hard ceiling before any real-money run).
> VPS = **Hetzner**. Pilot = **5 domains / 15 inboxes / 2 IPs**. Operational defaults confirmed:
> arm inbox-health auto-pause at **50**; SMTP steady cap **15/day/inbox**; rest **45d**; drain
> **14d**; reserve pool **~20% of active, min 3**. These are locked inputs for Phases 2–5.

Decisions the phases below assume (recommendation in bold):

| # | Decision | Recommendation |
|---|---|---|
| 0.1 | VPS vendor | **Hetzner** (fallback OVH) |
| 0.2 | Registrar for automation | **Porkbun primary**, Spaceship client also built (cheapest-TLD arbitrage later) |
| 0.3 | Monthly domain spend cap | **$50/mo** to start (≈4–5 domains/mo) — enforced fail-closed in code |
| 0.4 | Arm existing auto-pause (`inbox_health_offline_threshold`) | **Set to 50 now** — zero code, immediate protection for the live Gmail fleet |
| 0.5 | SMTP-tier steady-state cap | **15/day/inbox** (below Gmail tier's 20) |
| 0.6 | Rest duration default | **45 days** |
| 0.7 | Drain window | **14 days** |
| 0.8 | Reserve pool target | **~20% of active inboxes** per tier, minimum 3 |
| 0.9 | Pilot scale | **5 domains × 3 inboxes = 15 SMTP inboxes, 2 IPs, 1 VPS** |

Accounts/keys Daniel creates when each phase starts: Porkbun API key+secret (P2),
Spaceship API key+secret (P2, optional at pilot), Hetzner account + VPS + port-25
unblock ticket (P4), Workspace DWD scope additions (P3).

---

## 4. Phase 1 — Domains become first-class + burn-prevention substrate

**Ship first; applies to the existing Gmail fleet immediately.** ~1 session.

> **BUILD STATUS (2026-08-26, code local & unpushed; migration APPLIED to prod):**
> - ✅ **DONE** — migration `00081_create_sending_domains.sql` (table + `domain_id` FK +
>   `ramp_baseline_sent` + `provider` CHECK→`smtp` + idempotent backfill) — **APPLIED &
>   verified against prod** (`exedxjrifprqgftyuroc`): 3 domains created, 5 mailboxes linked,
>   0 unlinked/mismatched, all `active`/baseline 0, `provider` CHECK now `{gmail,smtp}`.
>   `SendingDomain`/`DomainLifecycle`/`DomainTier`/`DomainRegistrar` types + two `NativeMailbox`
>   fields; `src/lib/deliverability/lifecycle.ts` (pure: `decideLifecycle`,
>   `shouldTripCircuitBreaker`, `domainOpenForNewLeads`, `domainCanSend`, `enterTimers`,
>   `nextWatchStreak`) + `scripts/test-lifecycle.ts` (64/64); dispatcher ramp-reset offset +
>   step-0 drain filter (`domainOpenFor`) + domain prefetch; **domain health rollup** in
>   `check-inbox-health` (worst-member score/band/components + daily `watch_streak` →
>   `sending_domains`; reconciled against live mailbox scores). All tsc-clean; behavior-
>   identical for the live fleet.
> - ✅ **DONE (2nd pass):** the Phase 5 `manage-mailbox-lifecycle` cron (§8, gated observe-only
>   via migration 00082); the fast bounce circuit breaker in `poll-native-replies` (trailing-24h
>   hard-bounce burst → tire the domain within a minute, gate-aware); the optional per-domain
>   daily send cap (migration 00083, off by default). 88/88 lifecycle tests; tsc-clean.
> - 👤 **DANIEL:** deploy (push to master) so the health rollup populates `sending_domains` and
>   the new crons run (observe-only until armed); then, when ready, arm the lifecycle automation
>   (`organizations.domain_lifecycle_enabled = true`) and/or the inbox-health auto-pause
>   (`inbox_health_offline_threshold = 50`) — both live-data writes, a `/data-op` each.
>
> **Circuit-breaker sequencing note:** wiring the fast breaker to set a domain `tired`
> only auto-recovers once the Phase 5 lifecycle cron exists to drain→rest→re-warm it.
> Wired alone, a transient 3-bounce burst would close a live domain's intake until Phase 5
> ships. So the breaker wiring should land WITH the Phase 5 cron (or behind an owner-approved
> threshold), not standalone. The protective half that IS safe now — the drain *filter* —
> already shipped; it simply has nothing tiring domains yet.

**Migration `00081_create_sending_domains.sql`** (check numbering before creating — the
sequence already has 00074/00078 duplicate-number collisions):

- `sending_domains`: `id`, `organization_id`, `domain` (unique per org), `tier`
  CHECK (`gmail`,`smtp`), `lifecycle_status` CHECK (`provisioning`,`warming`,`active`,
  `tired`,`resting`,`burned`,`retired`), `lifecycle_changed_at`, `rest_until`,
  `drain_until`, `registrar` (`porkbun`,`spaceship`,`manual`), `registered_at`,
  `expires_at`, `purchase_price_usd`, `dkim_verified_at`, `ip_address` (SMTP tier; groups
  domains per IP for rollups), `health_score`/`health_components`/`health_checked_at`
  (domain-level rollup), `notes`, timestamps. RLS matching `native_mailboxes`.
- `native_mailboxes.domain_id` FK → backfill by extracting the domain from
  `email_address` and creating `sending_domains` rows for every existing mailbox
  (tier `gmail`, lifecycle `active`).
- Extend `native_mailboxes.provider` CHECK to (`gmail`,`smtp`) — the value was reserved
  in 00056, the constraint just doesn't admit it yet.
- `native_mailboxes.ramp_baseline_sent` INT DEFAULT 0 — **the ramp-reset mechanism**:
  the dispatcher passes `totalSent - ramp_baseline_sent` into `effectiveDailyCap()`.
  Reactivating a rested mailbox sets the baseline to its current all-time count, so it
  re-enters stage 1 (5/day) instead of resuming at 20/day. One-line change at the
  `remaining()` call in `run-native-sequences`; `ramp.ts` itself stays pure.

**Code:**
- Domain rollup in `check-inbox-health`: run SPF/DKIM/DMARC/MX/DBL **once per domain**
  (kills the current redundant per-mailbox lookups), store on `sending_domains`;
  mailbox scores keep their per-mailbox signals (bounce, replies, placement).
- Dispatcher (`run-native-sequences`) changes:
  - Step-0 mailbox selection excludes mailboxes whose domain is not `warming`/`active`
    (that IS drain mode — sticky follow-ups are untouched because they bypass selection).
  - Fast bounce circuit breaker (guardrail table) — on trip: set domain `tired`,
    `drain_until = now` (intake already closed by the tired state), owner alert.
  - Per-domain daily-volume defense-in-depth cap.
- Arm auto-pause (decision 0.4): settings UI already stores the threshold; set it.
- Unit tests: lifecycle transition rules as a pure module
  (`src/lib/deliverability/lifecycle.ts`) with a `scripts/test-lifecycle.ts` runner,
  same pattern as `scripts/test-waterfall-routing.ts`.

**Verify:** tsc clean; lifecycle unit tests; run health cron locally and confirm domain
rollups populate; confirm existing Gmail mailboxes' behavior is byte-identical while
their domains are `active` (the only behavioral change on day one is protection).

---

## 5. Phase 2 — Registrar automation (Porkbun + Spaceship)

> **SHIPPED to master 2026-08-26 (commit `b26ea0f`, migration 00084 applied); FINISHED 2026-08-27
> (local, unpushed).** The base layer (`src/lib/registrar/`: pure core + `porkbun`/`spaceship`
> clients + `auth` loader; `/api/admin/registrar/{settings,test,provision}`; the Settings Domain
> registrars card) shipped on the 26th. The 2026-08-27 finish closed the real gaps:
> - **True DNS upsert** (`dns.ts` `diffDnsRecords`): TXT matched by semantic slot (never deletes an
>   unrelated token), MX/A/AAAA/CNAME claim their group exclusively (strays deleted). Porkbun now
>   read-diff-creates/edits/deletes (was append-only, dup'd on retry); Spaceship read-merge-writes.
> - **Spaceship fixes**: availability price now parses the standard fields (`extractRegistrationPrice`,
>   was premiumPricing-only → every normal domain read null → locked out of buy-where-cheaper);
>   `registerDomain` fetches the account's saved contact + polls the 202 async operation. STILL
>   PENDING LIVE VERIFY (marked in-file): exact price field, contacts path, async-op path, DNS
>   PUT replace-vs-merge — one read-only `scripts/probe-spaceship.ts` run pins them.
> - **Reachability**: `/api/admin/registrar/quote` (price, no buy) + `suggest` (lookalikes) + a
>   split **Porkbun | Spaceship** selector and provision card on Admin → Mailboxes (`registrar`
>   forced-choice added to `/provision`). Provisioned-domain DNS is now readable/re-writable via
>   `GET`/`POST /api/admin/domains/[id]/dns` (first real caller of `getDnsRecords`); the
>   `dns_written:false` case is recoverable (Retry DNS).
> - **Fail-closed alert**: a blocked purchase enqueues a `registrar_spend_cap` owner alert; the
>   provision insert now writes `expires_at`; the unused `providerFor` import is gone.
> - Tests: `scripts/test-registrar.ts` 84/84 (+34: diff slots/exclusivity, price-parse ordering).
>
> **URL forwarding — SHIPPED to master 2026-08-31.** `RegistrarProvider` gains
> `supportsUrlForwarding` + `get/setUrlForwards`; Porkbun implements it against its API
> (`addUrlForward`/`getUrlForwarding`/`deleteUrlForward`, with an idempotent by-subdomain diff in
> `src/lib/registrar/forwarding.ts` — apex + www, 301 permanent by default); Spaceship has NO
> forwarding API so its client throws `ManualForwardingRequiredError` (dashboard-only). Surfaces:
> `GET`/`POST /api/admin/registrar/forward` (read status / set), a per-domain **URL forwarding**
> panel in the Mailboxes domain detail (set/change after the fact), and an optional forward field
> in the onboarding wizard's Review step (best-effort on Create, Porkbun only). `test-registrar.ts`
> now 120/120 (adds forward builder/diff/mapping + explicit fwd1/fwd2.porkbun.com MX-cleanup).
>
> **Provisioning reliability — SHIPPED to master 2026-08-31** (first live Porkbun provision run,
> tubeforseo.com). A Porkbun/Spaceship domain with **no API key** now FAILS the DNS step loudly
> ("add the key, then Retry DNS") instead of silently skipping — the silent skip left the
> `google-site-verification` TXT unwritten and surfaced later as an opaque Google 400. The
> site-verification wait shows an actionable hint (Site Verification vs Workspace Directory flag →
> verify in Google Admin to force it); the wizard registrar picker reflects what's connected +
> warns on an unconnected pick; the settings card flags a key saved **without its secret**; the
> domain detail shows a current-step status banner (step + full message + "checked Nx / last ...").
> NB: the apex-MX exclusivity rule already deletes Porkbun's default `fwd1/fwd2.porkbun.com` MX
> whenever the Google MX is written — it only lingers when the DNS write itself was skipped.
>
> **Daniel to-do:** create Porkbun (+ Spaceship) API keys, enter them + the $25 cap in Settings,
> Test each; Spaceship also needs one saved contact in its dashboard. Then run
> `npx tsx scripts/probe-spaceship.ts` once to pin its response shapes before the first live buy.

~0.5–1 session. Both registrars verified (2026-08-26) to support availability checks,
**registration/purchase**, and full DNS record CRUD via API.

- `src/lib/registrar/` — `types.ts` (provider interface: `checkAvailability`,
  `registerDomain`, `upsertDnsRecords`, `getDnsRecords`), `porkbun.ts`, `spaceship.ts`
  (Spaceship auth = `X-Api-Key` + `X-Api-Secret` headers).
- Keys as `organizations` columns (existing pattern): `porkbun_api_key`,
  `porkbun_api_secret`, `spaceship_api_key`, `spaceship_api_secret`, plus
  `registrar_monthly_spend_cap_usd`. Settings card on Admin → Integrations with
  Test-connection buttons (mirror the Million Verifier card).
- **Spend cap enforced fail-closed** like the MV budget: every purchase writes
  `purchase_price_usd` to `sending_domains`; month-to-date sum ≥ cap ⇒ refuse + owner
  alert. No cap set ⇒ no automated purchasing at all.
- DNS record-set builders per tier: Gmail tier (Google MX, `include:_spf.google.com`,
  DMARC `p=none` at first) vs SMTP tier (our MX, our SPF, DMARC; DKIM record comes from
  Mailcow's API in Phase 4).
- Lookalike-name generator (configurable patterns: `try{brand}.com`, `get{brand}.com`,
  `{brand}hq.com`…), availability-checked, never the primary brand domain.

**Verify:** availability + DNS record round-trip live against a $10 test domain
(explicit owner OK before the purchase call — real money); spend-cap refusal unit test.

---

## 6. Phase 3 — Google Workspace provisioning (Gmail-tier growth)

> **BUILT 2026-08-27 (local, unpushed; migration 00097 APPLIED to prod 2026-08-27).** The whole
> flow is code-complete + unit-verified; migration is live (4 columns added, backfill linked 0 —
> the existing 5 mailboxes were already linked by 00081). Only live activation (Daniel's Google
> setup + a real provision) remains.
> - **Auth substrate**: `src/lib/google/auth.ts` extracted the DWD JWT minter out of the Gmail
>   client into a shared `GoogleServiceAccount` (scope-aware token cache — the old cache key was
>   scope-blind and would have collided Gmail vs Directory tokens). Gmail errors now subclass the
>   generic Google ones; the Gmail client's public API is byte-identical (`scripts/test-google-auth.ts`
>   23/23).
> - **Admin-subject clients**: `src/lib/google/{directory,site-verification,licensing}.ts` +
>   `org.ts` (`loadWorkspaceAdminForOrg`). Per-API scopes (never a union), 409/412 = resume.
> - **State machine**: `src/lib/deliverability/provisioning.ts` (pure) + `provisioning-runner.ts`
>   (the impure advancer) run the steps in order — DNS → domains.insert → site-verify token+TXT →
>   verify → users.insert → licenses → mailboxes (`native_mailboxes` row with `domain_id`) → DKIM.
>   Idempotent/resumable; passwords returned once, never stored; `scripts/test-provisioning.ts`
>   48/48. **Gmail send-as/signature step deliberately skipped** (our MIME builder writes the From
>   header, so a server-side alias would never be read).
> - **Routes + cron**: `POST /api/admin/domains/[id]/workspace` (start), `/provisioning/advance`
>   (Check now), `/dkim` (paste the value → written via registrar), `/dns` + `/dns/apply`, plus
>   `POST /api/admin/domains` (track an owned domain, zero spend). The `advance-domain-provisioning`
>   cron (every 10 min, vercel.json) advances stuck steps, stamps `dkim_verified_at`, and applies
>   the provisioning→warming flip **itself** (NOT gated by `domain_lifecycle_enabled`, since it's
>   explicit owner-initiated setup; guarded provisioning→warming so it can't stomp a later state).
>   Patience-thresholded `domain_provisioning` owner alerts.
> - **UI**: the per-domain provisioning stepper (setup form, Check now, DKIM paste, password
>   reveal, DNS panel) on Admin → Mailboxes. NEEDS Daniel visual sign-off.
>
> **DWD scopes Daniel adds to the existing SA client ID (paste ALL — editing REPLACES the list):**
> ```
> https://www.googleapis.com/auth/gmail.send
> https://www.googleapis.com/auth/gmail.readonly
> https://www.googleapis.com/auth/admin.directory.domain
> https://www.googleapis.com/auth/admin.directory.user
> https://www.googleapis.com/auth/siteverification
> https://www.googleapis.com/auth/apps.licensing
> ```
> Plus enable **Admin SDK API + Site Verification API + Enterprise License Manager API** on the
> SA's Google Cloud project, and set `google_admin_email` (a super-admin) in Settings. If the
> tenant does NOT auto-license, also set the license product/SKU (else the licenses step skips).
> **Zero-spend live test:** "Track an existing domain" on a domain Daniel already owns → the whole
> flow runs without buying anything.

~1–1.5 sessions. Huge head start discovered in the survey: **domain-wide delegation is
already the org auth model** (`organizations.gmail_service_account_email/key`) — new
Workspace inboxes need zero per-mailbox OAuth.

- **Daniel one-time:** in the Workspace admin console, add scopes to the existing DWD
  grant — Admin SDK Directory (users + domains), Site Verification, Licensing — and we
  store `organizations.google_admin_email` (a super-admin to impersonate; Directory API
  requires an admin subject, unlike Gmail sends).
- Flow (admin API route + "Provision domain" panel on Admin → Mailboxes):
  1. Buy domain + base DNS via Phase 2.
  2. `domains.insert` (secondary domain on the existing tenant — capacity ~600).
  3. Site Verification API token → TXT via registrar → confirm.
  4. `users.insert` ×3 with license assignment; Gmail send-as/display-name/signature
     via Gmail API.
  5. Insert `native_mailboxes` rows (`provider='gmail'`, `domain_id`) + `sending_domains`
     row in `provisioning`.
  6. **DKIM — the one manual step** (no Google API for key generation, re-verified
     2026-08-26): panel shows "Generate DKIM in admin console" checklist per domain;
     a DNS poller watches for `google._domainkey.<domain>` TXT and auto-advances the
     domain to `warming` when it appears + verifies. Generation is manual (~2 min/domain,
     batchable); **detection and activation are automatic.**
- Blast-radius note (standing): one tenant = one suspension domain. Keep the Gmail tier's
  cold share bounded; a second tenant (manual signup) is the scale-out path later.

**Verify:** provision one real domain end-to-end → 3 inboxes appear in Admin →
Mailboxes in `warming`, ramp from 5/day, first placement probe runs.

---

## 7. Phase 4 — SMTP tier: server + channel + risk routing

~2 sessions Claude work + the external waits. New deps: `nodemailer` (send),
`imapflow` + `mailparser` (reply ingest) — none present today.

**Infrastructure (Daniel creates, Claude configures via SSH/Bash):**
Hetzner VPS (~CPX21), port-25 unblock ticket, 2 additional IPs with PTR set to the mail
hostname, Mailcow install (dockerized) — scripted + documented in a runbook
(`docs/smtp-runbook.md`). Mailcow's REST API covers domain add, mailbox create, **and
DKIM key generation** — so unlike Google, the SMTP tier provisions 100% hands-off:
registrar buy → DNS (incl. DKIM TXT from Mailcow's API) → mailboxes → `native_mailboxes`
rows, no human step.

**App-side channel (`src/lib/smtp/`):**
- `mailcow.ts` (provisioning client; host/key as org columns), `send.ts` (submission on
  587 with per-mailbox credentials, encrypted at rest like the Gmail SA key), reusing the
  existing MIME builder; `native_sends.rfc_message_id` (exists) is the join key for
  replies, so no Gmail-specific columns are needed for the new path.
- **Channel-agnostic sender seam:** `run-native-sequences` and `placement-runner.ts`
  currently call the Gmail client directly (verified — `gmail.sendMessage` at
  placement-runner.ts:198). Introduce `sendForMailbox(mailbox, mime)` dispatching on
  `provider`; placement tests then work for SMTP mailboxes against the same
  `seed_inboxes` with zero schema change.
- **Reply/bounce ingest:** extend `poll-native-replies` with an IMAP path for
  `provider='smtp'` (same `last_polled_at` watermark), matching inbound
  `In-Reply-To`/`References` → `native_sends.rfc_message_id`; DSN/bounce handling reuses
  the existing logic so bounce-rate health signals and contact flips work identically.
- **SMTP ramp:** `SMTP_RAMP_STAGES` in ramp.ts (start 3/day, +1 every 2 days, cap 15)
  selected by provider; `ABSOLUTE_MAX_DAILY_CAP` unchanged as the ceiling. Health cron
  gains an IP-blacklist check (Spamhaus via existing DQS key) keyed on
  `sending_domains.ip_address`, and a per-IP volume rollup guardrail.

**Risk-tier routing (the catch-all strategy):** the MV gate deliberately runs *last* (no
credit spent on sends that wouldn't happen) — routing must not move it. Two-pass design:
when the gate returns `catch_all` (or `unknown` exhausted its retries) and the campaign
pool contains active SMTP mailboxes, the dispatcher does **not** send from the Gmail
mailbox; it pins `enrollment.native_mailbox_id` to a least-loaded SMTP mailbox and holds.
Next tick the send fires from the SMTP tier — the 30-day verification cache makes the
re-check free, and sticky threading keeps the whole sequence on that mailbox. Campaigns
with no SMTP pool keep today's exact behavior (send flagged risky). `ok` results never
route to SMTP.

**Verify:** live loop on the pilot — provision a domain hands-off, send to seed inboxes
(placement test from an SMTP mailbox), reply from a seed → appears in `lead_replies`,
force a bounce → circuit breaker trips and the domain goes `tired`. Then a real
catch-all contact routes Gmail→SMTP and threads correctly.

---

## 8. Phase 5 — Lifecycle automation cron

> **BUILT 2026-08-26 (local, unpushed).** `manage-mailbox-lifecycle` at `:45` hourly,
> registered in vercel.json. Gated observe-only by `organizations.domain_lifecycle_enabled`
> (migration 00082): OFF → computes + reports transitions, writes nothing; ON → applies
> them with side-effects (pause on rest, resume + ramp-reset on re-warm). Signal-gathering
> is the pure, unit-tested `gatherDomainSignals` in `lifecycle.ts`. The fast bounce circuit
> breaker lives in `poll-native-replies` (reacts within a minute, sets `drain_until`), and
> the timer-backfill here catches any domain tired without a timer.

~1 session. New cron `manage-mailbox-lifecycle` (hourly), registered in vercel.json:

- Applies every transition in §2 from the pure `lifecycle.ts` rules: warming→active
  (ramp + age + clean placement), watch-streak→tired, drain expiry→resting,
  `rest_until` expiry→warming (sets `ramp_baseline_sent`, fires a fresh placement
  probe), still-bad-after-rest→burned.
- Reserve pool: below target ⇒ SMTP tier auto-provisions (under the spend cap,
  fail-closed) / Gmail tier opens a provisioning checklist task; both alert.
- Daily owner digest via the existing owner-alerts pipeline: pool counts per
  tier/state, transitions taken, spend month-to-date, domains awaiting DKIM clicks.

**Verify:** unit-test every transition edge (including "resting domain still receives
replies" and "burned is terminal"); clock-skew cases; then a compressed live rehearsal
with minutes-long drain/rest windows on a test domain.

---

## 9. Phase 6 — Admin UI & observability

> **STARTED 2026-08-26 (local, unpushed).** `GET /api/admin/mailboxes` now also returns the
> org's `sending_domains` (lifecycle + health rollup + mailbox_count), and the Mailboxes page
> renders a **Sending domains card**: per-domain tier, lifecycle chip, health band + score,
> watch-streak, inbox count, and any daily cap. tsc-clean. **NEEDS Daniel's visual sign-off** —
> render-verification wasn't reliable in the build loop (another session's dev server). Still
> TODO: group the mailbox table by domain, the pool summary strip, and domain drill-in
> (placement history / spend / lifecycle timeline).

~0.5–1 session.

- Admin → Mailboxes: group by domain; tier + lifecycle chips; pool summary strip
  (active / warming / tired / resting / reserve per tier); domain drill-in with health
  rollup, placement history, spend, lifecycle timeline (`mailbox_health_checks` +
  lifecycle transitions).
- Google Postmaster Tools API pull as an extra Gmail-tier domain signal (needs
  meaningful volume before data appears — display "no data yet" honestly). Microsoft
  SNDS registration stays a documented manual step for the SMTP IPs.

---

## 10. Rollout order & scale math

1. **P1 substrate → live** (protects the existing Gmail fleet immediately; arm auto-pause same day).
2. **P2 registrar** → buy pilot domains.
3. **P4 SMTP pilot** (P3 Workspace automation can proceed in parallel — independent).
4. Pilot bakes 3–6 weeks (warmup) while placement tests accumulate. **Gate: SMTP-tier
   placement majority-inbox on seeds before any scale-up or real catch-all routing.**
5. **P5 lifecycle cron** live before the pilot's first domains can possibly tire.
6. Scale by formula: `sends/day ÷ 25 = inboxes; ÷3 = domains; ÷10 = IPs` — 1,000/day ≈
   40 inboxes / 13 domains / 2 IPs ≈ **$45–60/mo**; 3,000/day ≈ 120 / 40 / 4–6 ≈
   **$70–105/mo**.

## 11. Claude-time & external clocks

| Bucket | Estimate |
|---|---|
| Claude work (P1→P6) | **~6–8 focused sessions** total: P1 ≈1 · P2 ≈0.5–1 · P3 ≈1–1.5 · P4 ≈2 · P5 ≈1 · P6 ≈0.5–1 |
| Daniel touchpoints | Phase-0 decisions; API keys; VPS + port-25 ticket; DWD scopes + admin email; DKIM clicks (~2 min/domain, batchable); spend caps; per-phase push go-aheads |
| External waiting | Port-25 unblock (hours–days) · DNS/DKIM propagation (minutes–hours) · **IP+domain warmup 3–6 weeks calendar** (the true critical path) · rest cycles 30–90 days steady-state |

## 12. Anti-goals (will not build)

Duplicate sends to one recipient from multiple inboxes; warmup pools / synthetic
engagement; aged-domain purchases; sending to `invalid`/`disposable` from any tier;
any path exceeding 20/day/inbox; automated purchasing with no spend cap configured.
