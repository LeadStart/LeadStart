# LeadStart → self-serve SaaS (Instantly competitor) — gap analysis & plan

> Drafted 2026-08-22 from a 10-agent audit of the codebase, the SaaSassins flat design kit, and web research on Instantly, Apify, and competitor pricing. Local-only; nothing here has been built or committed. Evidence is cited as `path:line` so every claim can be re-checked.

## 0. The one-paragraph answer

LeadStart today is a **done-for-you agency console**: one organization row (the agency) holds every secret, accounts are invite-only, clients can only *view* (dashboard / inbox / settings), and every build-and-launch surface — mailboxes, campaign builder, prospecting, deliverability — is owner/VA-gated under `/admin`. The sending engine underneath is genuinely ahead of Instantly on honesty (real per-mailbox ramp with a hard 20/day cap, no warmup pool, no tracking pixels, DSN-based bounce handling, inbox-health auto-pause, per-client reply-based DNC), and billing is far more built than `PROJECT_STATUS.md` claims (full Stripe quote → checkout → webhook → subscription mirror). What is missing for a stranger to sign up, pay, connect their own Google Workspace, find leads, and launch alone is: **a tenant model + signup, entitlements and a kill switch, a self-serve mailbox-connect wizard, per-tenant send capacity, a client-operable lead finder with metering, an honestly-defined AI agent (the Claude classifier is currently switched *off* and the UI mislabels regex output as "Claude class"), a human-copy workflow object, legal/compliance/support surfaces, and the flat restyle.** Roughly 22–28 Claude sessions end-to-end; a first-paying-stranger MVP is ~12–15 sessions plus Daniel's decisions and a handful of external waits.

---

## 1. Decisions Daniel has to make first (everything below depends on them)

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | **Tenant model**: (a) each customer = a *client* row inside the LeadStart org, or (b) each customer = their own **organization ("workspace")** | **(b) workspace = organization** | The admin UI *is* the self-serve product (builder, mailboxes, contacts, prospecting, inbox oversight, deliverability). Under (b) a customer gets it wholesale and RLS already isolates by org (`00008_create_rls_policies.sql:12-21`). Under (a) every one of those surfaces must be ported to `/client` with new client-write RLS on ~10 tables (`00062` deliberately locked those down). (b) also makes LeadStart agency-ready out of the box: an agency customer gets org → clients → campaigns, exactly today's shape. Cost of (b): a provisioning routine, platform-level credential defaults, a `platform_admin` concept for Daniel, nav gating of agency-only pages, tenant-scoped alerts. |
| D2 | **How customers connect mailboxes** | **Launch Google-Workspace-only via domain-wide delegation (DWD) with a guided wizard; run OAuth + CASA as a parallel external track; Microsoft 365 out of scope for v1** | DWD is exempt from Google verification (customer's admin grants it). OAuth needs `gmail.readonly` for reply ingest, which is a **Restricted** scope → annual CASA Tier-2 assessment by a Google-empanelled lab (weeks of waiting, hundreds–thousands of dollars/yr), plus privacy policy/ToS/brand verification — none of which exist yet. `gmail.send` alone is only "Sensitive" but cannot read replies. Sources: Google's scope table (`developers.google.com/workspace/gmail/api/auth/scopes`), restricted-scope verification page. Instantly itself requires the Workspace admin to whitelist its OAuth app, so "your admin connects it in 5 minutes" is a normal ask. |
| D3 | **Per-mailbox 20/day hard cap** (`src/lib/gmail/ramp.ts:25-53`) stays a product invariant for self-serve? | **Yes — keep it, market it** | It is the ethical differentiator (Gmail's own bulk-sender guidance: start low, ramp slowly). Make it a per-workspace *policy* later if a tier needs 30, never an "unlimited" toggle. |
| D4 | **Lead source stance** (Apify?) | **Scrap.io stays primary for local-business discovery; add a provider interface; first new adapters = verified-email finder (Findymail/Prospeo) + pre-send verification (MillionVerifier); Apify Google Maps only as overflow; Apify "Leads Finder" B2B actors optional and labelled unknown-provenance** | Apollo scrapers were pulled from the Apify Store (ToS); the Apify Maps actor costs ~$7/1k *with* emails vs Scrap.io $3.50/1k all-in; the B2B "700M leads" actors don't disclose their source; LinkedIn scrapers expose downstream buyers (Proxycurl injunction, LinkedIn UA 8.2(4)). Details §6. |
| D5 | **Pricing ladder & trial** | Start from the 3-tier proposal in §9 (Launch $97 / Growth "humans write your copy" $497+$500 / Managed $1,250); **card-required 14-day trial** at launch | No rate limiting or abuse controls exist today (§8.2); a no-card trial invites throwaway signups. Revisit once Turnstile + limits ship. |
| D6 | **Sell sending infrastructure (domains/DFY mailboxes)?** | **No.** Guided "set up your own domain" checklist instead | It is the sharpest contrast with Instantly's "we retain domain ownership and administrator access" clause. Nothing in the repo can provision domains anyway. |
| D7 | **Re-enable the Claude classifier** (`src/lib/replies/pipeline.ts:21-24`, `USE_CLAUDE_CLASSIFIER = false`)? | **Yes, per-workspace setting, on by default for self-serve** (~$0.0005/reply) | Without it the "AI agent" is regex. Either flip it on or rename the UI labels before any AI copy ships. |
| D8 | **Who fulfils human-written copy** | LeadStart staff (Daniel/VA) via an internal queue, not a marketplace | Decides that a `copywriter` role + `copy_requests` table is enough; no contractor auth/payouts. |
| D9 | **Flat restyle choices** | Inter (body+headings), light brand-50 sidebar with solid brand-500 active pill, tinted badges (bg-50 / text-700 / border-200), radius 8 controls / 12 cards, one shadow tier (overlays only), solid chart fills at low alpha, dark mode deferred | Mirrors the kit defaults and shadcn's own sizes (h-9 = 36px). See §10. |
| D10 | **Does self-serve coexist with the marketing site's "territory exclusivity" promise?** | Exclusivity applies to the done-for-you tier only; self-serve is non-exclusive and says so | Self-serve signups cannot be territory-exclusive. |

---

## 2. What we already have (and what is better than Instantly)

Built, live, and honest — these become the marketing claims:

- **Real ramp, no warmup pool**: 5 → +1/day → 20 sends/mailbox/day, hard-capped in code (`src/lib/gmail/ramp.ts:25-53, 135-144`); Mon–Fri business-hours window; min 5-minute gap per inbox. Instantly's own help docs admit its pool auto-opens, auto-replies, and "automatically moves warmup emails from spam to the inbox" — i.e. automating the Gmail interface to game filters.
- **No tracking pixel, no link rewriting, nothing appended to the body** (`src/lib/gmail/mime.ts:5-12`).
- **Inbox health from real signals**: SPF/DKIM/DMARC/MX + Spamhaus DBL + 7-day hard-bounce rate + reply signal, scored hourly, auto-pause after two consecutive sub-threshold checks (`src/lib/deliverability/inbox-health.ts`, `src/app/api/cron/check-inbox-health/route.ts`). Independent tests put Instantly "health 85+" inboxes at 32–41% spam placement.
- **Hard vs soft bounce via DSN parsing**, stop-on-reply that ignores out-of-office, reply-based opt-out into a per-client DNC list enforced at send time (`run-native-sequences/route.ts:192-221, 385-406`).
- **Customer-owned mailboxes and domains, zero lock-in** — we never hold a domain or inbox.
- **Reply pipeline with retries and delivery receipts** (`docs/reliability.md`); deterministic spintax engine; 237-phrase spam-word lint; real-contact preview.
- **Billing**: Stripe plans ↔ Products/Prices sync, hosted quotes, Checkout with 14-day trial + setup fee, 9-event signed webhook, subscription/invoice mirror tables, admin cancel/pause/portal (`src/lib/stripe/*`, `docs/stripe-go-live.md`). `PROJECT_STATUS.md` / `CLAUDE.md` saying "Stripe placeholder" is stale.
- **Prospecting**: Scrap.io background search worker + two-layer decision-maker enrichment (Haiku + Perplexity) with per-business cost tracking.
- **Instantly's reputation is verifiable from non-competitor sources**: Trustpilot currently withholds its score ("breach of our guidelines… removed a number of fake reviews"; 24% one-star of 1,157); ToS says "ALL FEES… ARE NON-REFUNDABLE AND NON-CANCELLABLE"; help center says "We currently retain domain ownership and administrator access… unable to transfer them over"; AI Reply Agent charges 5 credits per draft "regardless of whether you send, edit, or use" it.

---

## 3. Gap inventory by subsystem

Each row: what exists → what's missing → what to build. Evidence in parentheses.

### 3.1 Accounts, signup, tenancy
- **Exists**: invite-only (`/api/invite` requires role `owner`, `src/app/api/invite/route.ts:45-50`); roles `owner|va|client`; JWT claims injected from `profiles` by the auth hook (`00009`); single org (`supabase/seed.sql:5-6`; `00062:4-6`).
- **Missing**: any `/signup`; org creation path (no INSERT policy on `organizations`, `00008:24-30`); email-confirmation flow; onboarding checklist; platform-operator concept; impersonation for support (`dashboard-shell.tsx:10-20` has an unused `actualRole`).
- **Security holes to close before strangers hold accounts**: `handle_new_user` trusts user-supplied `raw_user_meta_data.role/organization_id` (`00015_create_client_users.sql:37-50`) — if Supabase "Enable email signups" were ever on, anyone could mint an `owner`; `profiles` UPDATE policy has no column restriction while the JWT hook reads `profiles.role` (`00008:37-39`, `00009:11-19`); `/api/invite` and `/api/reset-password` use unpaginated `listUsers()`; team (VA/owner) invite links cannot be accepted because `/api/accept-invite` only resolves tokens via `client_users` (`invite/route.ts:114-121` vs `accept-invite/route.ts:18-26`).
- **Build**: service-role `POST /api/signup` that provisions org + owner profile + default client + `terms_accepted_at`; harden the trigger (ignore metadata role/org unless server-set); `platform_admin` flag on `profiles`; impersonation with an audit row; onboarding checklist driven by real state (mailbox count, subscription status, campaigns, enrollments); fix team invites; paginate lookups; keep anon signups OFF in Supabase.

### 3.2 Billing & entitlements
- **Exists**: see §2. Quote-driven only; paying does not create a login (`src/lib/stripe/webhooks.ts:79-186`; welcome page defers to "your LeadStart contact").
- **Broken as committed** (Report 5): every billing write incl. the Stripe webhook uses the anon cookie client against SELECT-only RLS (`00023`, `src/lib/supabase/server.ts:7-9`; no `createAdminClient` in `src/lib/stripe` or `src/app/api/billing`) and ignores errors; plan/quote POSTs write `plan-…`/`quote-…` strings into UUID PKs (`plans/route.ts:89-91`, `quotes/route.ts:93-95`); webhook accepts unsigned JSON when `STRIPE_SECRET_KEY` is unset (`webhooks/stripe/route.ts:20-30`); quote numbering is a non-atomic max+1. *Open question for Daniel: were RLS write policies hand-edited in the prod dashboard? If not, the webhook has never persisted anything.*
- **Missing**: self-serve plan picker/checkout; client-callable portal (and portal is configured to hide cancel — reverse for self-serve); entitlement columns on `pricing_plans`; enforcement anywhere (send cron, launch, mailbox create, import never read `client_subscriptions`); tenant kill switch (`clients.status='former'` is ignored by the cron, `run-native-sequences/route.ts:344`); `trial_will_end` / `checkout.session.expired` handling; client billing page; usage ledger.
- **Build**: fix-first pass; migration adding `max_mailboxes, max_contacts, included_monthly_sends, ai_agent, human_copy_included, billing_interval, stripe_annual_price_id, is_public` to `pricing_plans` and a denormalized `billing_status`/`plan_id` on the workspace; `src/lib/billing/entitlements.ts`; gating at four chokepoints (mailbox create, contact import, campaign activate, send cron skip) + a suspension switch; `POST /api/billing/checkout` (authenticated) reusing `createCheckoutSessionForQuote` logic; `POST /api/billing/portal/self`; `/billing` page in the workspace; `usage_ledger` table written by send/import/prospecting/AI routes.

### 3.3 Mailbox connection & deliverability
- **Exists**: one org-level service account + DWD (`src/lib/gmail/client.ts:1-12`, `org.ts:10-32`); owner-only `/admin/mailboxes` with live delegation check on add; DNS/DBL/bounce health; per-campaign DNS + copy pre-flight (owner/VA only).
- **Missing**: self-serve connect flow of any kind; per-mailbox OAuth tokens (and no encrypted storage — SA key is plaintext `TEXT`, `00056:57-61`); client-visible health/deliverability; DKIM selector is hard-coded to `google`; send window accepts only 5 US timezones; mailbox pool not editable after campaign creation; no Microsoft 365 / SMTP.
- **Build**: "Connect your Google Workspace" wizard (show LeadStart's SA client ID + exact scopes, link to the Admin-console page, "Verify" button using the existing `getProfile` check, per-domain status); platform-level SA default from env with per-org override; move secrets to Supabase Vault / encrypted column; guided sending-domain checklist reusing `check.ts`; deliverability panel in the workspace (health score + components + pre-flight); configurable DKIM selector; IANA timezone validation; editable mailbox pool. **External track**: OAuth consent app + privacy policy + demo video + CASA Tier-2 (only if/when consumer Gmail or non-admin users matter).

### 3.4 Send capacity (multi-tenant)
- **Exists**: cron every 5 min with a **platform-wide** budget of 20 sends/tick and 1/mailbox/tick (`run-native-sequences/route.ts:50-61`) ≈ 240/hour total; reply poller 10 mailboxes/40 messages per minute tick (`poll-native-replies/route.ts:33-41`); prospecting workers process one search / one enrichment run per minute globally.
- **Missing**: any per-tenant fairness. No plan volume number is honest until this changes.
- **Build**: per-workspace claim inside the tick (round-robin) and/or fan-out to one invocation per workspace/mailbox group; raise poller throughput per tenant; round-robin the prospecting workers by workspace and cap pages per tick.

### 3.5 Campaign builder & copy
- **Exists**: native builder (owner-only route `src/app/api/admin/campaigns/native/route.ts:38-40`), sequence edit/activate/pause (owner or VA), spintax engine + Haiku spintax rewriter (owner-only), spam-phrase lint, real-contact preview, per-campaign send window / daily-new-leads cap / sending strategy, client CSV import into an active campaign (500 rows/request, 5,000/day).
- **Missing**: AI sequence writer (brief → sequence) — the only AI copy route rewrites existing text; A/B variants; pre-send email verification (memory ranks this the #1 evidence-backed gap); token fallback syntax (`{{first_name|there}}`) and pre-activate token check (unknown tokens ship literally, null renders "Hi ,"); builder hides follow-up subject field and ships default `[problem]`/`[Your name]` placeholders if unedited; no test-send; no client-side DNC/suppression management; thin client campaign stats (only sent + positive).
- **Build**: in the workspace UI (reused under D1b): AI sequence writer route using Sonnet/Opus + `max_tokens 4096` (memory: Haiku under-spins) with human-review-before-apply; `campaign_step_variants` with deterministic assignment (reuse spintax seeding) + per-variant stats; verification vendor call at import with risky/invalid buckets; token fallback + pre-activate validation; fix builder defaults; test-send; DNC page + suppression upload; surface `nativeStatsFor` stats.

### 3.6 Lead finding
- **Exists**: Scrap.io only (hard-coded base URL + `country_code='us'`, `src/lib/scrapio/client.ts:11-12, 109-126`), admin-only (13 routes + RLS owner/VA, `00042:70-96`, `00044`), results cached as one JSONB per search (cap 5,000), per-**org** Scrap.io blacklist for dedup, save → `contacts` with `client_id NULL`, decision-maker enrichment with per-business cost tracking (~$0.003–0.005/business). No path from results into a campaign (`/enroll` has no UI caller; push-to-campaign never enrolls for native); save path skips the DNC check; `validate-key` is unauthenticated; `prospect_searches.expires_at` never pruned.
- **Missing**: provider abstraction; metering/credit ledger (Scrap.io credits burn on one key, `scrapio_credits_balance` never written); per-tenant fairness; "save & add to campaign"; a person-level verified-email source; provenance field on contacts.
- **Build**: `src/lib/prospecting/provider.ts` (`searchPage(query, cursor) → {rows, next_cursor, total}` + typeahead hooks), wrap Scrap.io as adapter #1, add `provider` + `external_run_id` columns; DB-side per-tenant seen-set instead of the org blacklist; credit ledger + quota check before queueing (lower the 5,000 cap for self-serve); factor the CSV import's insert+DNC+dedupe+enroll block into `src/lib/contacts/intake.ts` and add "Save & add to campaign"; email-finder adapter (Findymail/Prospeo) downstream of enrichment; Apify adapter (start run with `maxTotalChargeUsd`/`maxItems`, ad-hoc webhook on `ACTOR.RUN.SUCCEEDED` to `/api/webhooks/apify` with a per-run secret, re-fetch run for `usageTotalUsd`, page the dataset; idempotent on `actorRunId`) — Google Maps overflow first, B2B "Leads Finder" optional; auth on `validate-key`; prune cron; `country_code` as a parameter; `contacts.provenance`.

### 3.7 The "AI agent" (honest definition)
- **Exists**: keyword prefilter → (disabled) Haiku classifier → hot-lead email with signed dossier link → portal reply composer (manual, no AI drafting — standing rule) → outcome capture; referral contact extraction (displayed, never acted on); reclassify audit trail (never consumed); daily owner briefing + 5-minute alert digest (**global**, not per-org: `owner-alerts.ts:92-109`, `owner-heartbeat.ts:530-536`); in-app `notifications` table exists but nothing writes to it (topbar bell is dead).
- **Missing**: classifier on; lead scoring; calendar-confirmed meetings; referral auto-follow-up; in-app / webhook / Slack notifications; client reply digest; classifier feedback loop; honest UI labels ("Claude class" / "Why we flagged this" currently show regex reasons).
- **Build** — and market it as *"AI triages, humans reply"*: enable Haiku per workspace; rename labels to "Classification"; lightweight lead score on `lead_replies` (class weight × confidence + title seniority + company signals) and sort inboxes by it; referral → create/merge contact under same client and optionally enroll at step 0; write `notifications` rows + wire the bell; per-workspace outbound webhooks (`reply.classified`, `lead.hot`, `contact.bounced`) reusing the retry-notifications pattern (covers Zapier/Slack/CRM); daily/weekly workspace reply digest (reuse the heartbeat's campaign-activity query filtered by org); feedback-loop view (reclassified_from → final_class per prefilter reason); tenant-scope alerts + heartbeat and keep a platform-wide briefing for `platform_admin` only; AI sequence writer (§3.5). Explicitly **not**: auto-sent replies (Instantly's Autopilot) — that is the differentiator and the standing rule.

### 3.8 Human-written copy (the other differentiator)
- **Exists**: nothing. Roles are `owner|va|client`; `tasks` is a generic org-wide to-do with no client/campaign FK or assignee; `campaign_steps` has no draft/review state or author; `lead_feedback` is lead-quality, not copy.
- **Build**: `copy_requests` (org, client, campaign, step nullable, status `requested|assigned|drafted|client_review|revision|approved|applied`, assigned_to, brief, draft_subject/body, due_at, sla_hours, approved_by/at, applied_at) + `copy_request_revisions`; `copywriter` role (or `profiles.can_write_copy`) with RLS limited to assigned requests; `campaigns.copy_mode` (`self|ai_assisted|human`) entitled from the plan; block activation of a `human` campaign while any step's request isn't approved; on approval write `campaign_steps` via the existing update-sequence logic; workspace screens: request (brief form), review/approve with comments, status + SLA countdown; admin queue; signed-URL email approve links (pattern in `send-hot-lead.ts`). Recurring deliverable (one sequence/month + refresh) — so it is a queue object, not a one-off quote.

### 3.9 Compliance, legal, support, go-to-market
- **Exists**: reply-based opt-out + per-client DNC (documented stance: no List-Unsubscribe / links — keep it, explain it in the ToS); `/api/contact` form (no rate limit); site-chat FAQ bot (built, not embedded).
- **Missing**: ToS, Privacy Policy (with Google Limited-Use language), Acceptable Use Policy, DPA — none exist in app or website; acceptance at signup; CAN-SPAM physical postal address (no column on `clients`, nothing enforces it or an opt-out line in copy); data export/delete endpoints; retention schedule; help center; in-app support entry; pricing page (website `vercel.json:9-10` **permanently 301s `/pricing` → `/quote`**); "Start free trial" CTA (site only has "Log in"); Instantly migration path (the `src/app/api/admin/instantly/*` routes *link* a workspace, they don't import; `src/lib/instantly/client.ts` is reusable).
- **Build**: `clients.postal_address` required before first activation; copy check blocks activation for self-serve if a step lacks an opt-out sentence or the address token; DNC check on prospecting save; export/delete-my-data routes; legal pages on the website + `profiles.terms_accepted_at`/`terms_version` + re-accept interstitial; static help center + `support_requests` table/form; replace the `/pricing` 301 with a real page and add the trial CTA; "Switch from Instantly" wizard (API key → pull campaigns/sequences/leads/blocklist via v2 → write `campaign_steps`, `contacts`+enrollments with status preserved, `dnc_entries`); a positioning doc built on the four verifiable Instantly facts (§2).

### 3.10 Engineering readiness & observability
- **Exists**: email-based alerting only; `typescript.ignoreBuildErrors: true` (`next.config.ts:5-9`); CI lint/typecheck `continue-on-error` (`.github/workflows/ci.yml:41-47`); no test runner; no security headers; no MFA; no error tracker (130 `console.error/warn` calls are the logging layer).
- **Build**: rate-limit store (Upstash or a Supabase table keyed by IP+route) + Turnstile on signup/contact/reset + disposable-email blocking; Sentry (or equivalent) tagged with `tenant_id`/`user_id`; zero the lint/TS baseline and make CI blocking; Vitest for the pure modules that already have script harnesses (ramp, spintax, tokens, prefilter); `headers()` with CSP/HSTS/X-Frame-Options; Supabase MFA for platform accounts; status page.

---

## 4. Recommended tenant architecture (under D1b)

- **Workspace = `organizations` row.** Signup provisions: org → owner profile (`role='owner'`) → one default `clients` row representing the customer's own company → `terms_accepted_at`. Agencies add more clients; solo customers never see the distinction beyond a single "brand."
- **Platform layer**: `profiles.platform_admin boolean` (Daniel, VA, copywriters). Cross-workspace reads via service-role routes gated on that flag; impersonation writes an audit row. Owner alerts/heartbeat scoped per org; a separate platform briefing for `platform_admin`.
- **Credentials**: platform defaults from env (Gmail SA, Spamhaus DQS, Anthropic, Perplexity, Scrap.io — Scrap.io already falls back to env, `src/lib/scrapio/auth.ts:55-63`) with optional per-workspace override ("bring your own key"). Secrets move to Vault/encrypted columns.
- **Nav gating**: a workspace sees Dashboard, Campaigns, Mailboxes, Contacts, Lead Finder, Inbox, Reports, Team, Billing (own subscription), Settings. Hidden unless `platform_admin`: Clients list (shown to a workspace only when it has >1 client), Quotes/admin billing, Prospects kanban (LeadStart's own sales pipeline), Instantly/Unipile/API-key cards, Feedback (keep for agencies), Tasks (keep, org-scoped). `is_internal` clients (`00048`) stay an agency-only concept — exclude from provisioning, tenant lists, and quotas.
- **Subscriptions** key on the workspace's default client row initially (zero schema churn for the billing tables); add `organizations.stripe_customer_id` later if cleaner.
- **Existing agency clients are untouched**: Daniel's org remains org #1 with its clients and the done-for-you portal.

---

## 5. Mailbox connection — the decision in detail

| Path | Google verification | Who can connect | Replies | Status |
|---|---|---|---|---|
| **DWD (current)** | None (exempt) | Google Workspace **admins** only; not `@gmail.com` | Yes (`gmail.readonly` via delegation) | Built; needs a self-serve wizard |
| OAuth `gmail.send` only | Brand + app verification + demo video (Sensitive) | Any Google user | **No** — cannot read the inbox | Not viable alone |
| OAuth `gmail.send` + `gmail.readonly` | Above **+ annual CASA Tier-2** (Restricted) | Any Google user | Yes | External track: privacy policy, ToS, consent screen, lab assessment (weeks; $) |
| Microsoft 365 (Graph) | Microsoft publisher verification | M365 users | Yes | Not built; separate channel |

Launch on DWD. The wizard is ~1 session: show the SA client ID + scope string, deep-link to the Admin-console Domain-wide-delegation page, a per-domain "Verify" that calls `getProfile`, and clear error copy for the two common failures (scopes typo, propagation delay). Positioning: *"We only send from your own Google Workspace. No rented inboxes, no burner accounts, nothing we keep when you leave."*

---

## 6. Lead finding — answering the Apify question

Short version: **Apify works technically and the integration is simple (Bearer REST, `POST /v2/acts/{id}/runs` with `maxTotalChargeUsd` as a hard budget, ad-hoc webhooks on run finish, dataset paging), but it should not be the primary source.**

- **Local businesses (today's ICP)**: Scrap.io at ~$3.50/1k with emails/phones/socials and API on every plan beats Apify's Google Maps actor (`compass/crawler-google-places`, ~$1.50/1k bare, ~$7/1k with emails). Keep Scrap.io; add the Maps actor only as pay-as-you-go overflow.
- **B2B people (Instantly's lead finder)**: Apollo scrapers are gone from the Apify Store (Apollo ToS); the three "Leads Finder" actors ($1–1.5/1k) don't disclose provenance. If used: verify every email before sending, label the source, never market it as "Apollo data."
- **LinkedIn**: avoid every scraper (cookie-based ones risk the customer's account; cookieless ones still expose downstream buyers — Proxycurl injunction, UA 8.2(4)). Unipile stays the only LinkedIn path.
- **Best person-level path**: a first-party finder that charges only on verified hits — Findymail (~2.1¢/email, <5% bounce guarantee) or Prospeo (~2–4¢, API on all tiers) — downstream of the existing decision-maker enrichment, plus MillionVerifier-class verification (~$1/1k decisive) at import.
- **Cost pass-through**: Apify has no per-customer sub-billing; record `usageTotalUsd` per run against the workspace and bill in LeadStart credits at 2–3× markup. Keep a `provenance` field on every contact.

---

## 7. Phased build plan (Claude time; a "session" = one focused build + verify stretch)

Phases A and B have no dependencies on the decisions and can start immediately, in parallel with Daniel deciding §1.

| Phase | Scope | Claude time | Daniel touchpoints | External waiting |
|---|---|---|---|---|
| **A. Flat restyle** (§10) | globals.css + shared primitives; PageHeader extraction across 31 files; UI_RULES.md; optional hex→token pass | 2–3 sessions | D9 choices; visual sign-off on 5 reference screens | — |
| **B. Hardening + fix-first** | billing writes → admin client / RLS; UUID PK bug; webhook fail-closed; quote counter RPC; `handle_new_user` trust fix; profiles role-column guard; team-invite fix; paginate `listUsers`; auth on `validate-key`; rate-limit store + Turnstile on public routes; tenant kill switch honoured by the send cron; tenant-scope owner alerts/heartbeat; docs drift (`PROJECT_STATUS`, Settings "Coming Soon" Stripe card) | 2 sessions | Confirm prod RLS state on billing tables (one `pg_policies` query); confirm Supabase "Enable signups" is OFF; apply migration(s) via dashboard | — |
| **C. Workspace tenancy + signup + self-serve billing** | provisioning routine; `/signup`; onboarding checklist; `platform_admin` + impersonation; nav gating; platform credential defaults + Vault; entitlement columns; `entitlements.ts` + 4 gating points; `usage_ledger`; authenticated checkout; self portal; workspace `/billing` page; `trial_will_end`/`checkout.session.expired`; ToS acceptance fields | 4–5 sessions | D1, D5; Stripe dashboard (live products, portal config allowing cancel, webhook events); Vercel env; migration apply | Stripe live-mode smoke test |
| **D. Mailbox connect + capacity** | DWD wizard; sending-domain checklist; workspace deliverability panel; DKIM selector; IANA timezones; editable mailbox pool; send-cron per-workspace fan-out; poller + prospecting fairness | 2–3 sessions | D2, D3; a test Workspace domain to walk the wizard end-to-end | DNS propagation on the test domain |
| **E. Builder for solo operators** | AI sequence writer (Sonnet/Opus); A/B variants; pre-send verification; token fallback + pre-activate check; builder default fixes; test-send; DNC page; richer workspace stats; compliance gates (postal address, opt-out line) | 3–4 sessions | Verification vendor account; decide "advisory vs blocking" pre-flight | — |
| **F. Lead finder** | provider interface + Scrap.io adapter; seen-set; credit ledger + quotas; intake lib + "Save & add to campaign"; email-finder adapter; Apify adapter + `/api/webhooks/apify`; prune cron; `provenance` | 3–4 sessions | D4; Apify / Findymail accounts; pricing unit per credit | Actor testing |
| **G. AI agent** | classifier on per workspace; label honesty; lead score; referral follow-up; in-app notifications + bell; outbound webhooks; workspace digest; feedback-loop view | 2–3 sessions | D7 | — |
| **H. Human copy service** | `copy_requests` + revisions; `copywriter` role; `copy_mode`; workspace request/review screens; admin queue; activation gate | 2 sessions | D8; SLA and price | — |
| **I. GTM, legal, support, observability** | legal pages + acceptance; help center + support form; pricing page (remove the `/pricing` 301) + trial CTA + positioning copy; "Switch from Instantly" wizard; Sentry; CI blocking + tests; security headers; MFA; status page | 3–4 sessions | Legal review of ToS/Privacy/AUP/DPA; website copy approval; Trustpilot screenshot for the record | Legal turnaround |
| **J. (optional track) OAuth + CASA** | consent app, privacy policy language, demo video, refresh-token storage, assessment | 1–2 sessions of code | Google Cloud project; pay the lab | **Weeks** (assessment + Google review) |

**Totals**: ~22–28 Claude sessions for A–I. **First-paying-stranger MVP** = B + C + D + the compliance/legal minimum from I + the builder subset of E (token safety, default fixes, postal address gate) ≈ **12–15 sessions**, with A running alongside.

---

## 8. Cross-cutting risks the plan must not ignore

1. **Signup trust chain** — `handle_new_user` + JWT hook + RLS all trust `profiles.role`; harden before any public signup (B).
2. **Platform send ceiling ~240/hour total** — fan out before publishing any volume number (D).
3. **Billing may never have persisted** — verify prod policies before trusting the subscription mirror (B).
4. **No rate limiting anywhere** public-facing (B).
5. **No kill switch** — `clients.status='former'` is ignored by the sender (B).
6. **AI claims vs reality** — classifier off + mislabelled UI + `docs/reliability.md:43` still says Haiku is live (G, and fix the doc in B).
7. **Org-level secrets in plaintext** (`00056:57-61`) — Vault before multi-tenant (C).
8. **Expired-prospect JSONB growth** (5,000 businesses/row, never pruned) (F).
9. **Marketing promise collision** — exclusivity vs self-serve (D10).

---

## 9. Pricing starting point (for Daniel to validate against unit costs)

Market rungs (2026): ~$39–69 entry (Smartlead $39, Instantly $47, Lemlist $69), ~$94–109 "serious" (Instantly Hypergrowth $97, Smartlead Pro $94, Apollo Pro $99), $170–380 unlimited/agency; every vendor bundles unlimited mailboxes + warmup, 14-day trials, ~17–20% annual discounts — but lead data, AI agents, CRM, and warmup tools stack on top (a working Instantly stack is $124–180/mo). **No SaaS vendor sells human-written copy**; it lives with agencies at $1,500–5,000+/mo. AI-SDR products: AiSDR $250–2,500, Reply Jason $500–1,500, Artisan ~$280–3,000, 11x ~$5k/mo on annual minimums.

| Tier | Price | Includes | Rationale |
|---|---|---|---|
| **Launch** (self-serve) | $97/mo ($77 annual) | up to 3 Workspace mailboxes on the ramp, 2,500 contacts, 10k emails/mo, 500 lead credits, AI triage + hot-lead alerts on every plan, inbox health, reports, CSV import. Add-ons: mailbox $7/mo, 1,000 credits $19 | Same rung as every competitor's "serious" plan but bundles what they meter separately; honest comparison is Instantly's $124–180 stacked cost |
| **Growth — humans write your copy** | $497/mo ($397 annual) + $500 onboarding | Launch + one human-written 4–5 step sequence/month with spintax + monthly refresh from reply data, list building (2,000 credits), 10 mailboxes, 10k contacts, 50k emails, monthly 30-min review | A single freelance sequence is $500–2,000; sits in the empty band between $100 SaaS and $1,500+ agencies; cap at ~3 staff hours/client/month |
| **Managed + AI SDR** | $1,250/mo ($1,050 annual) + $1,000 onboarding | Growth + 25 mailboxes, 25k contacts, 150k emails, 5k credits, unlimited sequences with ongoing A/B iteration, human reply handling + meeting booking, weekly call, LinkedIn when Unipile activates (no infra resale — D6) | Below Reply Jason Growth $1,500, Cleverly $1,995, AiSDR $2,500, SalesBread $3,000, Belkins $5k+; "an AI SDR with a human on the loop, month-to-month" |

Conventions to match so nothing reads as a red flag: 14-day trial (card-required at launch, D5), 20% annual, month-to-month, volume-based not per-seat, cancel in-app. Claim as features: one subscription, no expiring credits, no sub-subscriptions that keep billing, pro-rated refunds, advance notice before annual renewal — each maps to a documented Instantly complaint.

---

## 10. Flat restyle — what changes

**Reference**: `C:\Users\danie\Documents\Saasassins\Styling\STRUCTURE.md` (numbers, flat doctrine §5, scaffolds §6, mobile §7) + `C:\Users\danie\Documents\Saasassins\shell-build\app\src\theme-flat.css` (checklist of every depth effect to null) + `shell-build\UI_RULES.md §40`. Do **not** port the shell's class vocabulary or its CSS linter; map the kit onto shadcn/Tailwind v4 tokens.

**Current state** (Report 6): "Clean Modern Blue" neumorphic/gradient theme lives almost entirely in `src/app/globals.css` as `!important` overrides keyed on shadcn `data-slot`s (card with triple box-shadow + vertical gradient, 11px uppercase CardTitle forced everywhere — it even overrides the login "Welcome back", gradient `.btn-gold`/`.btn-dark`, gradient input borders, gradient table header + zebra, six gradient badge classes, SVG-masked nav notch, aurora `body::before`); sidebar is an inline white→#6B72FF gradient; the page "hero band" is an identical inline gradient block copy-pasted into **28 dashboard files + 3 auth pages** with no shared component; 58 inline `#2E37FE` chips across 24 files; ten dead gradient utility classes; `dark` variant declared but no `.dark` tokens and no ThemeProvider. Confirmed cascade bugs: default buttons 10px radius vs outline 20px; login button colour beaten by `.btn-gold`.

**Token mapping**: `--background ← surface-base (#f6f8fb)`, `--card ← #fff`, `--muted ← surface-sunken (#f1f5f9)`, `--border ← #e2e8f0`, `--primary ← brand-500` (keep LeadStart blue), `--foreground ← #0f172a`, `--muted-foreground ← #64748b`, `--ring ← rgba(brand,0.4)`, `--radius: 0.5rem` (8px controls; `rounded-xl` = 12px on Card). Tailwind's spacing is already the 4px grid; shadcn `h-9/h-8/h-7/h-11` = the 36/32/28/44 control tiers.

**Phase A (~10 files, one session)**: `globals.css` — delete the `@layer utilities` gradient block, the aurora, the card/card-title/input/table/badge/nav-notch/stat-card `!important` rules, `.btn-gold/.btn-dark`; `card.tsx` → `rounded-xl border bg-card` (no shadow); `button.tsx` → plain Tailwind variants (fix the 6 direct `btn-*` usages); table → `bg-muted/50` header, no zebra, `hover:bg-muted/50`; **keep the six `badge-*` class names** (27 files and three lib modules return them as data: `replies/ui.ts`, `kpi/definitions.ts`, `deliverability/inbox-health.ts`) but redefine as tinted flat (`bg-emerald-50 text-emerald-700 border-emerald-200` etc.; `badge-slate` becomes real slate, not teal); sidebar → solid `bg-sidebar border-r`, delete the cast-shadow div, collapse the three duplicated nav maps, replace the "LeadStart Agency" footer; nav active = `bg-primary text-primary-foreground rounded-md`, hover = `bg-primary/10`; `stat-card.tsx` drop `stat-card-gold`; `kpi-card.tsx` → solid 50-tint + hairline, no `hover:shadow-md`; `daily-chart.tsx` solid fills at `fillOpacity 0.08`, soften tooltip shadows; `stage-flow-card.tsx` solid banner/connector/pills; keep `shadow-lg` only on Dialog/Popover/DropdownMenu/Toast.
**Phase B (~31 files, one session)**: `src/components/layout/page-header.tsx` (eyebrow, title, subtitle, actions; plain typography, no box) replacing the inline hero block everywhere — mechanical search/replace + build.
**Phase C (optional, 1–2 sessions, ~58 files)**: hex → tokens (`bg-[#2E37FE]`→`bg-primary`, `text-[#0f172a]`→`text-foreground`, …); prerequisite for any real dark mode or white-label.
**Also**: font → Inter via `next/font` (PROJECT_STATUS P4 item); write `UI_RULES.md` at the repo root recording every ruling (the `/visual-pass` and `/ship` skills expect it); verify with `npm run build` + screenshots of admin overview, campaigns list, client dashboard, login, campaign detail (stage-flow) — those five cover every restyled primitive. Public quote/welcome pages and email templates are a separate later pass.

---

## 11. Open questions still unanswerable from the repo

- Supabase dashboard state: "Enable email signups" on/off; any hand-edited RLS on billing tables; MFA settings. (Daniel, one look each.)
- Are live Stripe keys + the 9 webhook events configured in prod? (`scripts/backfill-stripe.mjs` implies real subscriptions existed.)
- Provenance of the Apify "Leads Finder" databases (ask the maintainers) and written confirmation from Apify that Store output may be served to LeadStart's customers (their T&C read as internal-use).
- Exact Scrap.io cost per page and enrichment cost per business at current volumes — needed to validate the credit allotments and tier margins in §9.
- Target buyer for public pricing: local/SMB services (assumed above) vs B2B SaaS teams (tolerates per-seat and higher AI-SDR prices).

---

## Appendix — sources behind the external claims

Google scope classes: `https://developers.google.com/workspace/gmail/api/auth/scopes` (gmail.send = Sensitive; gmail.readonly/metadata/modify/compose = Restricted); restricted-scope verification + CASA: `https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification`; verification requirements by category: `https://support.google.com/cloud/answer/13464321`. Instantly: `https://instantly.ai/pricing`, `https://help.instantly.ai/en/articles/10273259-instantly-plans-overview`, `https://help.instantly.ai/en/articles/5975329-how-warm-up-works-and-why-it-s-important`, `https://help.instantly.ai/en/articles/9361043-done-for-you-google-email-setup`, `https://help.instantly.ai/en/articles/11774076-ai-reply-agent`, `https://instantly.ai/terms`, `https://www.trustpilot.com/review/instantly.ai` (observed 2026-08-22), `https://help.instantly.ai/en/articles/6697278-how-to-connect-google-accounts-via-google-oauth-method`. Apify: `https://apify.com/scrapers/apollo`, `https://apify.com/compass/crawler-google-places`, `https://apify.com/code_crafter/leads-finder`, `https://docs.apify.com/api/v2`, `https://docs.apify.com/platform/integrations/webhooks/ad-hoc-webhooks`, `https://apify.com/pricing`. Scrap.io: `https://scrap.io/pricing`, `https://apidoc.scrap.io/`. Finders: `https://www.findymail.com/pricing`, `https://coldiq.com/blog/prospeo-pricing`, `https://apify.com/account56/email-verifier`. LinkedIn legal: `https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/`. Apollo ToS: `https://www.apollo.io/terms`. Competitor pricing: `https://www.smartlead.ai/pricing`, `https://www.lemlist.com/pricing`, `https://woodpecker.co/pricing/`, `https://www.saleshandy.com/pricing/`, `https://aisdr.com/pricing`, `https://www.artisan.co/pricing`, `https://belkins.io/appointment-setting`, `https://saleshive.com/pricing-packages/`.
