# Stripe Billing Integration — Plan

> **Status:** Draft — pending decisions in the "Decisions needed" section below. Not yet approved.
> **Last updated:** 2026-04-18

---

## Resume Brief (read this first)

### What this is
A full Stripe integration that replaces the placeholder `/admin/billing` page with a real billing system. Flow: admin finishes onboarding → **sends a branded quote** (pre-filled HTML page at a signed URL) → client reviews → clicks **Accept & pay** → lands in Stripe Checkout → pays setup fee → **14-day trial starts (warming period)** → subscription auto-bills right before campaign launch → webhooks keep Supabase in sync → branded emails via Resend throughout. Stripe sends its own PDF invoices/receipts. Stripe Customer Portal is still available for card updates + invoice history, but **cancel is disabled in the portal** — only admin can cancel.

### Owner answers locked in (from 2026-04-18 scoping convo)
- **Checkout entry point:** admin sends a quote post-onboarding; payment link is generated on quote acceptance (no self-serve signup).
- **Billing structure:** one-time setup fee (per-client amount, not per-plan) charged at checkout + subscription with a fixed **14 calendar day** trial so first recurring charge lines up with campaign launch.
- **Cancellation:** admin-only. Stripe Customer Portal is configured to hide the cancel button; clients can still update their card and see invoice history there.
- **Pricing:** current Starter/Growth/Scale numbers are placeholders — plans must be editable in the admin UI, with Stripe Product/Price records created on save.
- **Test mode first:** everything wired against `sk_test_*` keys before flipping live.

### Decisions locked in

| # | Question | Answer |
|---|---|---|
| 1 | Setup fee location | **Per-client** — entered on each quote; no `setup_fee_cents` field on `pricing_plans` |
| 2 | Warming period | **14 calendar days, hardcoded**. Stored on `client_subscriptions` as a snapshot for audit |
| 3 | Who can cancel? | **Admin only.** Stripe Customer Portal configured with cancel disabled; clients can still update card + view invoices |
| 4 | Annual plans? | **Monthly only for v1** |
| 5 | Tax (Stripe Tax)? | **Skip v1** |
| 6 | Metered/usage billing? | **No — flat subscription only** |
| 7 | Refund/pro-ration on cancel? | **No pro-ration** — service runs until period end |
| 8 | Client-facing billing page? | **No** — clients get no `/client/billing` page; they interact with billing only through the quote + checkout + Stripe Portal (link emailed when needed) |

### Quote step — new decisions needed (from 2026-04-18 scoping convo)

A formal quote/proposal precedes every payment link: admin fills a pre-filled form → system generates a branded HTML quote at a signed URL → client reviews → **Accept & pay** triggers Stripe Checkout.

| # | Question | Recommended default | Alternative |
|---|---|---|---|
| 9 | Accept button on quote page — direct to Checkout, or admin-mediated? | **Direct** — clicking Accept immediately redirects to Stripe Checkout | Accept just logs acceptance; admin then manually triggers payment link |
| 10 | PDF attachment on the quote email? | **No — hosted HTML only for v1**; clients can print-to-PDF from the page | Generate branded PDF with `@react-pdf/renderer` and attach via Resend |
| 11 | Quote expiry default | **7 days** from send | 14 days, or indefinite until manually voided |
| 12 | E-signature on acceptance? | **Click-accept + audit trail** (IP, email confirm, timestamp, user-agent) | Drawable signature capture (heavier; needs review) |

Reply with overrides or "use defaults" to lock these in, then I'll start commit #1.

### What the owner needs to provide (when ready to go live)
1. Stripe account with business details filled in.
2. **Stripe test keys** — `STRIPE_SECRET_KEY` (sk_test_…) + `STRIPE_PUBLISHABLE_KEY` (pk_test_…) from dashboard.
3. **Webhook signing secret** — `STRIPE_WEBHOOK_SECRET` — generated when you add the webhook endpoint in Stripe dashboard (or by `stripe listen` locally).
4. **Stripe CLI** installed locally for dev webhook forwarding: `stripe listen --forward-to localhost:3000/api/webhooks/stripe`.
5. When flipping to live: re-run the plan-sync (creates live-mode Product/Price for each plan) and swap env vars.

### Security to-dos flagged during planning
- Every mutation route that creates/modifies billing state must use `createAdminClient()` + verify caller's org role before hitting Stripe.
- Stripe webhook must verify `Stripe-Signature` header; never trust payload without verification.
- HMAC-signed quote URLs so the public `/quote/[id]` page cannot be enumerated or accessed without the token.
- Rotate any Stripe keys that end up in git history, same policy as the Instantly key on `scripts/backfill-emails.mjs:9`.

### Next step when resuming
**Commit #1**: migration + types + demo mock data. Renders the new Billing UI structure against mock data, zero external services needed. Safe opener matching the AI-reply pattern.

---

## Context

The current `/admin/billing` page ([src/app/(dashboard)/admin/billing/page.tsx](../../src/app/(dashboard)/admin/billing/page.tsx)) is entirely placeholder — it reads from `MOCK_BILLING` in [src/lib/mock-data.ts:434](../../src/lib/mock-data.ts). No real Stripe calls anywhere in the repo.

Real-world flow we're automating:
1. Admin onboards a client (existing flow, unchanged).
2. Admin opens client detail page → **Send quote**.
3. Admin picks plan (or "custom"), enters setup fee, reviews pre-filled scope of work + terms, picks expiry date (default +7 days). Form shows preview of exact charges and first-recurring-charge date (always +14 days from checkout).
4. System inserts a `quotes` row (status=`sent`), generates a signed quote URL, and Resend sends a branded proposal email with a big **Review proposal** button.
5. Client opens the quote page → reviews terms → clicks **Accept & pay** → system marks `quotes.status='accepted'` with audit fields → creates a Stripe Checkout session (subscription mode, 14-day trial + setup fee line-item) → redirects to Checkout.
6. Client pays setup fee in Stripe → trial starts.
7. Stripe fires `checkout.session.completed` → our webhook creates `client_subscriptions`, updates `clients.stripe_customer_id`, marks quote+payment-link complete, triggers "you're in, first charge on {date}" email.
8. 14 days later, trial ends → Stripe charges first month → `invoice.paid` → mirror into Supabase, optional thank-you email.
9. Renewal failure → `invoice.payment_failed` → Resend nudge + admin sees flag; Stripe's own dunning still runs.
10. Client wants to update card → admin emails them a one-time Customer Portal link (generated on demand); cancel option is disabled in the portal's configuration.

---

## Architecture at a glance

```
Admin UI (send quote)
  └─ POST /api/billing/quotes
       ├─ Insert quotes row (status=sent, expires_at=+7d, signed_url_hash)
       └─ Resend → branded "Your LeadStart proposal" email
                    link → /quote/[id]?t=<hmac>

Client opens quote page (public, HMAC-protected, no auth)
  ├─ GET sets quotes.viewed_at
  └─ [ Accept & pay ] →
       POST /api/billing/quotes/[id]/accept (verify HMAC)
         ├─ Mark quotes.status=accepted + audit (ip, email, ua, timestamp)
         ├─ Insert payment_links row
         ├─ Create Stripe Checkout Session
         │    mode=subscription
         │    line_items: [setup_fee_price (ad-hoc one-time), monthly_price (recurring)]
         │    subscription_data.trial_period_days: 14
         │    client_reference_id: <client_id>
         └─ 303 redirect → Stripe Checkout URL

Client pays → Stripe Checkout → trial begins
                        │
Stripe fires events ────┘
  └─ POST /api/webhooks/stripe  (verify Stripe-Signature)
       ├─ Dedupe on stripe_event_id
       ├─ checkout.session.completed → upsert client_subscriptions; mark quote+payment_link complete
       ├─ customer.subscription.updated/deleted → update status, period_end
       ├─ invoice.paid → insert billing_invoices, Resend thank-you
       ├─ invoice.payment_failed → update status, Resend nudge
       └─ invoice.finalized → insert billing_invoices (open status)

Admin /admin/billing (real data)
  ├─ MRR from active client_subscriptions × plan.monthly_price_cents
  ├─ Quotes tab: drafts, sent, accepted, expired
  ├─ Subscriptions tab: active, trialing, past_due, canceled
  ├─ Invoices tab: from billing_invoices (links to Stripe hosted_invoice_url)
  ├─ "Cancel" button → POST /api/billing/subscriptions/:id/cancel (admin-only)
  └─ "Email Portal link" → POST /api/billing/portal → emails one-time Portal URL to client
```

---

## Data model (migration: `supabase/migrations/00023_create_billing.sql`)

Migration number follows `00022_create_reply_pipeline.sql` (see AI reply plan).

### New table: `pricing_plans`
Replaces `BILLING_PLANS` constant. Editable in admin UI; synced to Stripe on save. **Setup fee lives on `quotes`, not here** (per decision #1).

- `id uuid pk`, `organization_id uuid fk`, `slug text unique` (starter/growth/scale)
- `name text`, `description text`, `features jsonb default '[]'`
- `monthly_price_cents integer not null`
- `currency text default 'usd'`
- `stripe_product_id text` — populated on first save
- `stripe_monthly_price_id text` — populated on first save
- `scope_template text` — pre-fills the "Scope of work" on new quotes
- `active boolean default true`, `sort_order integer`
- `created_at`, `updated_at`

**Price records are immutable in Stripe.** If admin changes `monthly_price_cents`, we **archive** the old Stripe price and **create a new one**; stored Stripe IDs update. Existing subscriptions keep their old price (Stripe's default behavior) — admin must explicitly migrate them.

### New table: `quotes`
One row per quote sent. Snapshot pricing at time of send, since plans are editable.

- `id uuid pk`, `organization_id uuid fk`, `client_id uuid fk`
- `quote_number text unique` — friendly e.g. `Q-2026-0012` (auto-sequence per org)
- `plan_id uuid fk → pricing_plans` (nullable — allows "custom" quotes)
- `plan_name_snapshot text` — preserved even if plan renamed/deleted
- `monthly_price_cents integer` — snapshot from plan at time of send
- `setup_fee_cents integer not null default 0`
- `currency text default 'usd'`
- `scope_of_work text` — pre-filled from `plan.scope_template` + client notes, editable
- `terms text` — pre-filled from org-level default, editable
- `signed_url_hash text` — HMAC hash; verified on public quote page load
- `status text` — `draft | sent | viewed | accepted | declined | expired | canceled`
- `expires_at timestamptz`, `sent_at`, `viewed_at`, `accepted_at`, `declined_at`
- `sent_to_email text`, `sent_by uuid fk → profiles`
- `accepted_by_email text`, `accepted_ip text`, `accepted_user_agent text` — audit trail
- `stripe_checkout_session_id text` — populated when Accept triggers Checkout
- `created_at`, `updated_at`

**Indexes:** `(organization_id, status, created_at desc)`, `(client_id, created_at desc)`, unique `quote_number`.

### New table: `client_subscriptions`
One row per subscription (clients may re-subscribe after cancel).

- `id uuid pk`, `organization_id uuid fk`, `client_id uuid fk`
- `plan_id uuid fk → pricing_plans`, `quote_id uuid fk → quotes` (the quote that created it)
- `stripe_customer_id text not null`
- `stripe_subscription_id text unique`
- `status text` — `incomplete | trialing | active | past_due | canceled | paused`
- `trial_end timestamptz`, `current_period_start`, `current_period_end`
- `cancel_at_period_end boolean default false`, `canceled_at timestamptz`
- `setup_fee_cents integer`, `setup_fee_paid_at timestamptz`
- `warming_days_at_signup integer default 14` — snapshot; constant today but column future-proofs
- `created_at`, `updated_at`

**Indexes:** `(organization_id, status)`, `(client_id, created_at desc)`, unique `stripe_subscription_id`.

### New table: `billing_invoices`
Mirror of Stripe invoices for fast admin-page rendering without live Stripe calls.

- `id text pk` — Stripe invoice ID (`in_…`)
- `organization_id uuid fk`, `client_id uuid fk`
- `stripe_customer_id text`, `stripe_subscription_id text`, `stripe_invoice_number text`
- `amount_cents integer`, `amount_paid_cents integer`, `amount_due_cents integer`, `currency text`
- `status text` — `draft | open | paid | uncollectible | void`
- `period_start timestamptz`, `period_end timestamptz`
- `hosted_invoice_url text`, `invoice_pdf_url text`
- `issued_at timestamptz`, `paid_at timestamptz`
- `created_at`, `updated_at`

**Indexes:** `(organization_id, issued_at desc)`, `(client_id, issued_at desc)`, `(status)`.

### New table: `payment_links`
One row created when a quote is accepted and a Stripe Checkout session is generated. Separate from `quotes` so we can handle future flows (e.g. one-off invoices, re-sends) that don't need a full quote.

- `id uuid pk`, `organization_id uuid fk`, `client_id uuid fk`
- `quote_id uuid fk → quotes` (nullable — supports non-quote sources later)
- `stripe_checkout_session_id text unique`
- `stripe_checkout_url text`
- `status text` — `pending | completed | expired | canceled`
- `created_at`, `expires_at`, `completed_at`

### New table: `stripe_events` (idempotency log)
- `stripe_event_id text pk`, `event_type text`, `processed_at timestamptz default now()`
- `payload jsonb`, `error text`

### RLS
- `pricing_plans`, `client_subscriptions`, `billing_invoices`, `payment_links`: SELECT for owners/VAs in their org.
- Mutations on all tables via admin client only (API routes enforce role).
- `stripe_events`: admin client only.

### Column additions
- `clients`: `stripe_customer_id text` (nullable; set on first payment link completion so we can reuse for upsells).
- `organizations`: `stripe_account_configured boolean default false`, `stripe_live_mode boolean default false`.

---

## File-by-file change list

### Extend existing
- [src/app/(dashboard)/admin/billing/page.tsx](../../src/app/(dashboard)/admin/billing/page.tsx) — rewrite to read from Supabase; add tabs for Plans / Quotes / Subscriptions / Invoices
- [src/app/(dashboard)/admin/clients/[clientId]/page.tsx](../../src/app/(dashboard)/admin/clients) — add **Send quote** button (primary CTA) and "Email Portal link" action
- [src/lib/supabase/demo-client.ts](../../src/lib/supabase/demo-client.ts) — register `pricing_plans`, `quotes`, `client_subscriptions`, `billing_invoices`, `payment_links`, `stripe_events` in `TABLES`
- [src/lib/mock-data.ts](../../src/lib/mock-data.ts) — add `MOCK_PRICING_PLANS`, `MOCK_QUOTES`, `MOCK_CLIENT_SUBSCRIPTIONS`, `MOCK_BILLING_INVOICES`, `MOCK_PAYMENT_LINKS`; deprecate `MOCK_BILLING` + `BILLING_PLANS` shapes
- [src/types/app.ts](../../src/types/app.ts) — add `PricingPlan`, `Quote`, `ClientSubscription`, `BillingInvoice`, `PaymentLink` types
- [.env.example](../../.env.example) — add Stripe vars

### New files
- `supabase/migrations/00023_create_billing.sql` — full migration incl. `quotes` table and `quote_number` sequence
- `src/lib/stripe/client.ts` — Stripe SDK singleton; demo-mode no-op wrapper
- `src/lib/stripe/helpers.ts` — `syncPlanToStripe`, `createCheckoutSessionForQuote`, `createPortalSession`, `cancelSubscription`, `formatAmount`
- `src/lib/stripe/webhooks.ts` — event handlers per type, all idempotent
- `src/lib/quotes/numbering.ts` — next-quote-number generator (Q-YYYY-NNNN per org)
- `src/lib/security/signed-urls.ts` — HMAC-SHA256 (shared with AI-reply plan if that lands first; otherwise created here)
- `src/lib/email/templates/quote.tsx` — "Your LeadStart proposal" with CTA button
- `src/lib/email/templates/payment-failed.tsx` — "Your payment didn't go through"
- `src/lib/email/templates/subscription-started.tsx` — "You're live! First invoice on {date}"
- `src/lib/email/templates/portal-link.tsx` — one-time "Update your payment method" email
- `src/app/api/webhooks/stripe/route.ts` — signature verification + dispatch
- `src/app/api/billing/quotes/route.ts` — list + create quote (admin)
- `src/app/api/billing/quotes/[id]/route.ts` — update/send/cancel quote (admin)
- `src/app/api/billing/quotes/[id]/accept/route.ts` — public, HMAC-verified; creates Checkout session and returns redirect
- `src/app/api/billing/portal/route.ts` — admin-triggered; emails one-time Portal URL to client
- `src/app/api/billing/plans/route.ts` — list/create plans (admin)
- `src/app/api/billing/plans/[id]/route.ts` — update/archive plan (admin); calls `syncPlanToStripe`
- `src/app/api/billing/subscriptions/[id]/cancel/route.ts` — admin cancel (immediate or period-end)
- `src/app/quote/[id]/page.tsx` — **public hosted quote page** (no auth; HMAC token in URL); renders pricing breakdown, scope, terms, Accept button
- `src/app/(dashboard)/admin/billing/plans/[id]/page.tsx` — plan editor
- `src/app/(dashboard)/admin/billing/quotes/[id]/page.tsx` — admin quote composer/editor with live preview
- `scripts/fixtures/stripe-*.json` — synthetic webhook events for local testing

### Dependencies
- `stripe` (official Node SDK)
- No need for `@stripe/stripe-js` — we're using hosted Checkout + Portal, not Stripe Elements

---

## Checkout Session shape (the tricky part)

Setup fee is per-client (from the accepted quote), so we pass it as an **ad-hoc `price_data`** line item instead of a stored `price` — no pre-created Stripe price needed for each client's unique amount.

```ts
stripe.checkout.sessions.create({
  mode: "subscription",
  customer_email: client.contact_email,
  client_reference_id: client.id,
  line_items: [
    // Setup fee — one-time, ad-hoc amount from the quote
    ...(quote.setup_fee_cents > 0 ? [{
      price_data: {
        currency: quote.currency,
        unit_amount: quote.setup_fee_cents,
        product_data: {
          name: `Setup fee — ${client.name}`,
          description: `One-time onboarding and inbox warming`,
        },
      },
      quantity: 1,
    }] : []),
    // Subscription — stored monthly price from the plan
    { price: plan.stripe_monthly_price_id, quantity: 1 },
  ],
  subscription_data: {
    trial_period_days: 14,  // hardcoded per decision #2
    metadata: { client_id: client.id, plan_id: plan.id, quote_id: quote.id },
  },
  metadata: { client_id: client.id, plan_id: plan.id, quote_id: quote.id },
  success_url: `${APP_URL}/billing/welcome?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${APP_URL}/quote/${quote.id}?t=${token}&canceled=1`,
  payment_method_types: ["card"],
  expires_at: <24h from now>,
}, {
  idempotencyKey: `quote_accept_${quote.id}`,  // stops double-accepts creating dup sessions
});
```

**Why this works:** setup fee charges immediately (ad-hoc amount per client), subscription enters `trialing` for 14 days, first recurring charge fires on day 14. Stripe handles it all; we just listen on webhooks.

---

## Webhook events we handle

| Event | Action |
|---|---|
| `checkout.session.completed` | Upsert `client_subscriptions` row (status=trialing), update `clients.stripe_customer_id`, mark `payment_links.status='completed'`, trigger `subscription-started` email |
| `customer.subscription.updated` | Update `client_subscriptions.status`, `current_period_end`, `cancel_at_period_end`, `trial_end` |
| `customer.subscription.deleted` | Update `client_subscriptions.status='canceled'`, `canceled_at=now()` |
| `invoice.finalized` | Insert `billing_invoices` (status='open') |
| `invoice.paid` | Update `billing_invoices.status='paid'`, `paid_at`; if this is the first non-trial invoice, send "thanks, you're live" email once |
| `invoice.payment_failed` | Update `billing_invoices.status`, mark `client_subscriptions.status='past_due'`, send `payment-failed` email |
| `invoice.voided` / `invoice.marked_uncollectible` | Update `billing_invoices.status` |

**Every handler:** (1) check `stripe_events.stripe_event_id` — if exists, return 200 silently; (2) insert `stripe_events` row; (3) run handler; (4) on error, set `stripe_events.error` and return 500 so Stripe retries.

---

## Env vars (to add to `.env.example`)

- `STRIPE_SECRET_KEY` — `sk_test_...` in dev, `sk_live_...` in prod
- `STRIPE_WEBHOOK_SECRET` — `whsec_...` from dashboard or `stripe listen`
- `STRIPE_PUBLISHABLE_KEY` — `pk_test_...` / `pk_live_...` (reserved for future Elements use; optional now)
- `NEXT_PUBLIC_APP_URL` — used for Checkout `success_url`/`cancel_url` (likely already present, verify)

Existing vars (unchanged): Supabase keys, `RESEND_API_KEY`, `EMAIL_FROM`, `WEBHOOK_SECRET`.

---

## Demo mode parity

Everything no-ops under `DEMO_MODE=true`:
- Stripe client → returns mock session URLs (`https://checkout.stripe.com/demo/...`), mock customer IDs (`cus_demo_*`), mock subscription IDs (`sub_demo_*`)
- Webhook route → accepts any payload, writes to `stripe_events`, runs handlers against demo client (mock data already shaped for this)
- Portal session → returns demo URL that points to a "this would be Stripe Portal" page
- Plan sync → skips Stripe API, still persists to Supabase
- **Quote page → fully functional in demo mode**; Accept button records acceptance and redirects to a mock "/billing/welcome" page (no real Checkout)
- Resend → existing demo behavior (logs instead of sending)

---

## Idempotency, reliability, cost

- **Webhook dedupe** — `stripe_events.stripe_event_id` primary key
- **Checkout session reuse** — quote's `stripe_checkout_session_id` is set on first acceptance; re-accepting before expiry re-redirects to the same session (idempotency key `quote_accept_{quote_id}` on Stripe side also prevents duplicates)
- **Price archival, not edit** — changing plan price creates new Stripe price; existing subs keep old price until explicitly migrated (Stripe convention)
- **Idempotency-Key headers** — set on every `stripe.checkout.sessions.create` / `stripe.subscriptions.cancel` call using payment_link_id / subscription_id
- **Signature verification** — every webhook call validated before any DB write
- **Rate limits** — Stripe is 100 req/sec in live mode, 25 req/sec in test mode; we're nowhere close
- **Cost envelope** — Stripe takes 2.9% + 30¢ per charge; no monthly fees in test mode; zero dev cost

---

## Verification plan

**Local demo mode:**
1. `DEMO_MODE=true npm run dev`
2. Admin billing page renders plans from mock data, edit opens form
3. Client detail page → Send quote → compose form pre-fills → submit → Resend logs email in console, `quotes` row inserted, signed URL printed
4. Open the quote URL in incognito → page renders correctly → `viewed_at` updates → click Accept → lands on mock "/billing/welcome" page
5. `curl -X POST 'http://localhost:3000/api/webhooks/stripe' -H 'Content-Type: application/json' -d @scripts/fixtures/stripe-checkout-completed.json` → subscription appears in admin billing table

**Test-mode with real Stripe:**
1. Real test keys in `.env.local`, `stripe listen --forward-to localhost:3000/api/webhooks/stripe` running in another terminal
2. Create a plan in admin UI → verify Stripe dashboard shows matching Product + Price (monthly only)
3. Send quote to your own email → open quote URL → click Accept & pay → lands in Stripe Checkout with setup fee + monthly (trial) line items → use card `4242 4242 4242 4242` → complete
4. Webhook forward delivers `checkout.session.completed` → admin billing table updates within a second; quote shows `accepted`
5. Simulate trial expiry: `stripe trigger invoice.paid` → billing_invoices inserts, "you're live" email sent
6. Simulate failure: `stripe trigger invoice.payment_failed` → past_due status, payment-failed email sent
7. Admin clicks "Email Portal link" → client receives email → clicks link → Stripe Portal loads → cancel button is **hidden** → update card → webhook fires → our row updates
8. Admin cancels subscription → Stripe reflects it → billing page shows "canceled at period end"

**Regression:** login flow unchanged, report generation unchanged, AI-reply pipeline (when built) unaffected, no Stripe calls leak outside `src/lib/stripe/*`.

---

## Risks & mitigations

1. **Checkout trial + setup fee interaction** — Stripe behavior well-documented but easy to misconfigure. Mitigation: verification plan step #3 exercises it end-to-end before we trust it.
2. **Webhook event ordering** — Stripe doesn't guarantee order. Mitigation: handlers are state-based (upsert semantics), not sequential; trial_end comes from the event payload, not inferred.
3. **Price edits mid-billing** — admin could change a plan's price while a client is mid-subscription. Mitigation: archive+replace pattern; admin UI shows "Affects new customers only — existing customers stay on old price until migrated."
4. **Demo-mode bleed** — every stripe.* call must pass through `src/lib/stripe/client.ts` which guards on `isDemoMode()`. Enforce at code review.
5. **Webhook replay attacks** — handled by Stripe signature verification (timestamp tolerance) + our event-ID dedupe.
6. **Payment link email bounces** — Resend bounce handling not wired; for v1 admin can see "sent_at but no clicked_at" and resend manually.
7. **Live-mode flip** — forgetting to re-create Products/Prices in live mode would break things. Mitigation: admin billing page shows a banner "Test mode" vs "Live mode" and a one-click "Sync all plans to live" action.
8. **Currency assumption** — hardcoded USD v1. Multi-currency is a follow-up if needed.

---

## Rollout order (single feature branch, multiple commits)

Each commit leaves the app runnable:

1. **Migration + types + demo mock data** — admin billing page renders new tabs (Plans / Quotes / Subscriptions / Invoices) against mocks; old `MOCK_BILLING` removed
2. **`stripe` SDK + client singleton + env vars + demo-mode guards** — imports work, no real calls yet
3. **Plan CRUD in admin UI** — editor page, list view; `syncPlanToStripe` creates Stripe Product + Price on save (test mode); scope_template field
4. **Quote composer (admin)** — form to draft + preview a quote; saves as `draft` without sending
5. **Hosted quote page + signed URLs + `quote.tsx` email + `POST /api/billing/quotes[/:id]`** — admin can send; client can view; `viewed_at` recorded; page renders correctly on mobile
6. **Quote acceptance → Checkout session → `POST /api/billing/quotes/[id]/accept`** — Accept button actually creates a Stripe Checkout session and redirects; ad-hoc setup fee wired; 14-day trial hardcoded
7. **Webhook endpoint + signature verification + event dispatch** — `/api/webhooks/stripe` accepts events, dedupes on `stripe_events.stripe_event_id`, runs handlers
8. **Admin billing page wire-up (real data)** — MRR from Supabase, subscriptions table live, invoices table live, admin-cancel button
9. **Portal link emailing + Stripe Portal configuration** — admin can email a client a one-time Portal link; portal is configured to hide cancel button; `portal-link.tsx` email
10. **Remaining Resend templates + wiring** — `payment-failed`, `subscription-started`; triggered from webhook handlers
11. **Test-mode smoke test end-to-end (Stripe CLI) + README update + go-live checklist doc**
