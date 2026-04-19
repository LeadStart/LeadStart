# Stripe Billing — go-live & smoke test

End-to-end checklist for wiring Stripe into LeadStart. Pairs with [docs/plans/stripe-billing.md](./plans/stripe-billing.md).

---

## Step 1 — Stripe account prep

1. Create (or log in to) a Stripe account at https://dashboard.stripe.com.
2. Complete **business details** (name, tax info, bank for payouts). Stripe blocks live-mode charges until this is filled out.
3. Keep the dashboard in **Test mode** for now (toggle in the top-right nav).

## Step 2 — Local test keys

In `.env.local`:

```
STRIPE_SECRET_KEY=sk_test_...           # Dashboard → Developers → API keys
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...         # Generated in Step 4 below
NEXT_PUBLIC_APP_URL=http://localhost:3000/app
RESEND_API_KEY=re_...                   # Optional, skip if not testing emails yet
DEMO_MODE=                              # Leave blank (or remove) to disable demo fakes
```

Restart the dev server after setting these.

> While `DEMO_MODE=true` is set, every Stripe call is stubbed to a deterministic fake — handy for clicking around without keys but useless for verifying live behavior. To run against real Stripe, explicitly unset `DEMO_MODE`.

## Step 3 — Install the Stripe CLI

```bash
# macOS
brew install stripe/stripe-cli/stripe

# Windows (via scoop)
scoop install stripe
```

Log in once:

```bash
stripe login
```

## Step 4 — Forward webhooks to localhost

In a dedicated terminal:

```bash
stripe listen --forward-to http://localhost:3000/app/api/webhooks/stripe
```

The command prints a `whsec_...` signing secret — copy it into `STRIPE_WEBHOOK_SECRET` in `.env.local` and restart the dev server.

Leave `stripe listen` running for the remainder of testing.

## Step 5 — Portal configuration (one-time, in Stripe dashboard)

Per decision #3 (admin-only cancel), configure the Stripe Customer Portal so clients can update their card / view invoices but **cannot** cancel.

1. Dashboard → **Settings** → **Billing** → **Customer portal**.
2. Uncheck **"Cancel subscriptions"** under the Subscriptions section.
3. Leave **"Update payment method"** and **"Invoice history"** enabled.
4. Save.

Also set the portal's return URL to `{your-domain}/app/admin/clients` so the admin lands back on their dashboard after generating a portal link.

## Step 6 — Smoke test (test mode)

With the dev server + `stripe listen` both running:

### 6a. Plan sync
1. Open `/app/admin/billing` → **Plans** tab.
2. Click any plan card → bump the price → **Save changes**.
3. In Stripe dashboard → **Products**: verify the matching Product + Price exist with the new amount. The old Price should be **archived** (not deleted) if you changed the amount.

### 6b. Quote → Checkout → subscription
1. **Quotes** tab → **New quote**: pick a contact, plan, enter a setup fee, click **Send now**.
2. Check `quotes` in Supabase — the row should have `status='sent'`, `sent_at`, and a `signed_url_hash`.
3. Open the hosted quote URL (visible in the admin list or in the proposal email Resend delivered).
4. Click **Accept & pay** → Stripe Checkout opens with setup fee + monthly line items.
5. Use test card `4242 4242 4242 4242`, any future expiry, any CVC/ZIP.
6. Complete payment. Land on `/app/billing/welcome`.
7. In the `stripe listen` terminal, watch for `checkout.session.completed` → `customer.subscription.created` → `invoice.paid` (for the setup fee).
8. Back in the admin UI → **Subscriptions** tab: row should show **warming** status with the client.
9. Resend logs: **"You're in — campaigns launching soon"** email sent to the recipient.

### 6c. Trial-end / first monthly charge
Fast-forward the 14-day trial:

```bash
stripe trigger invoice.paid \
  --add invoice:subscription=sub_... \
  --add invoice:billing_reason=subscription_cycle
```

(Easier: advance the test clock in Stripe dashboard → **Billing** → **Test clocks**.)

Verify:
- `billing_invoices` row appears with `status='paid'`, period bounds, and hosted URL.
- **Invoices** tab shows it at the top.
- `client_subscriptions.status` flips from `trialing` to `active`.

### 6d. Failed payment
```bash
stripe trigger invoice.payment_failed
```

Verify:
- `client_subscriptions.status = past_due`.
- Subscriptions tab shows **past due** badge (red).
- Resend logs: **"We couldn't process your payment"** nudge email.

### 6e. Portal link
1. Subscriptions tab → **Portal** button on an active row.
2. The action should hit `/api/billing/portal` which creates a Stripe Portal session and emails the one-time URL to the client.
3. Open the email, click the link, confirm the Stripe Portal loads with **no cancel option** (per portal config), and card update works.

### 6f. Admin cancel
1. Subscriptions tab → **Cancel** → confirm dialog → **Cancel at period end**.
2. Row shows amber "Ends [date]".
3. In Stripe dashboard: subscription has `cancel_at_period_end: true`.
4. Webhook fires `customer.subscription.updated` → our row mirrors the flag.

---

## Step 7 — Going live

When ready to flip from test to live:

1. In Stripe dashboard, toggle off **Test mode**.
2. Copy the live API keys + add a live webhook endpoint (**Developers → Webhooks → Add endpoint**, point at `https://leadstart-ebon.vercel.app/app/api/webhooks/stripe`, select the same events as below).
3. Save the live webhook secret.
4. Update Vercel env vars with `sk_live_...`, `pk_live_...`, `whsec_...`, `NEXT_PUBLIC_APP_URL=https://leadstart-ebon.vercel.app/app`.
5. Re-configure the Portal in live mode (Step 5 is test-mode-only — redo for live).
6. **Sync plans to live mode:** in the admin Plans tab, save each plan once to generate live Stripe Product + Price records. (Live mode has separate products from test mode.)
7. Redeploy.

---

## Webhook events we subscribe to

Required for end-to-end correctness:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.finalized`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.voided`
- `invoice.marked_uncollectible`

When creating the webhook endpoint in Stripe dashboard, select exactly these.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Signature verification failed` in server logs | `STRIPE_WEBHOOK_SECRET` doesn't match the `whsec_...` printed by `stripe listen` or the dashboard endpoint | Re-copy the secret, restart the dev server |
| Webhook returns 500 repeatedly | Handler error — check `stripe_events.error` column in Supabase | Inspect the payload stored on that row, fix the handler, re-trigger with `stripe events resend <event_id>` |
| Checkout fails with "No such price" | Plan's `stripe_monthly_price_id` points at a test-mode Price but you're in live mode (or vice versa) | Re-save the plan in the current mode to generate the right Price id |
| Client has no Stripe customer | They haven't accepted a quote yet | Send a quote → customer is created on acceptance |
| Portal link 409 "has no Stripe customer" | Same as above | Send a quote first |

---

## Related files

- Plan: [docs/plans/stripe-billing.md](./plans/stripe-billing.md)
- Webhook handlers: [src/lib/stripe/webhooks.ts](../src/lib/stripe/webhooks.ts)
- Webhook endpoint: [src/app/api/webhooks/stripe/route.ts](../src/app/api/webhooks/stripe/route.ts)
- Stripe client: [src/lib/stripe/client.ts](../src/lib/stripe/client.ts)
- Plan sync / Checkout session: [src/lib/stripe/helpers.ts](../src/lib/stripe/helpers.ts)
- Migration: [supabase/migrations/00023_create_billing.sql](../supabase/migrations/00023_create_billing.sql)
