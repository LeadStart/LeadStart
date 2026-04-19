-- Billing: pricing plans, quotes, subscriptions, invoices, payment links, Stripe event log
-- See docs/plans/stripe-billing.md for the full plan.

-- ============================================================
-- pricing_plans — editable in admin, synced to Stripe on save
-- (setup fee lives on quotes, not here — per-client per decision #1)
-- ============================================================
CREATE TABLE IF NOT EXISTS pricing_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  monthly_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_product_id TEXT,
  stripe_monthly_price_id TEXT,
  scope_template TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_pricing_plans_org_active
  ON pricing_plans(organization_id, active, sort_order);

ALTER TABLE pricing_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Plans viewable by org members"
  ON pricing_plans FOR SELECT
  USING (organization_id = public.get_my_org_id());

-- ============================================================
-- quote_number_counters — per-org, per-year auto-incrementing
-- counter backing the human-friendly Q-YYYY-NNNN number
-- ============================================================
CREATE TABLE IF NOT EXISTS quote_number_counters (
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, year)
);

ALTER TABLE quote_number_counters ENABLE ROW LEVEL SECURITY;
-- No policies — service role only

-- ============================================================
-- quotes — snapshot pricing at send time (plans are editable)
-- ============================================================
CREATE TABLE IF NOT EXISTS quotes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  quote_number TEXT NOT NULL,
  plan_id UUID REFERENCES pricing_plans(id) ON DELETE SET NULL,
  plan_name_snapshot TEXT,
  monthly_price_cents INTEGER NOT NULL,
  setup_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  scope_of_work TEXT,
  terms TEXT,
  signed_url_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  expires_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  viewed_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ,
  sent_to_email TEXT,
  sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  accepted_by_email TEXT,
  accepted_ip TEXT,
  accepted_user_agent TEXT,
  stripe_checkout_session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (quote_number),
  CHECK (status IN ('draft', 'sent', 'viewed', 'accepted', 'declined', 'expired', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_quotes_org_status
  ON quotes(organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotes_client
  ON quotes(client_id, created_at DESC);

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Quotes viewable by org members"
  ON quotes FOR SELECT
  USING (organization_id = public.get_my_org_id());

-- ============================================================
-- client_subscriptions — mirror of Stripe subscription state
-- ============================================================
CREATE TABLE IF NOT EXISTS client_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  plan_id UUID REFERENCES pricing_plans(id) ON DELETE SET NULL,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  status TEXT NOT NULL,
  trial_end TIMESTAMPTZ,
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  canceled_at TIMESTAMPTZ,
  setup_fee_cents INTEGER,
  setup_fee_paid_at TIMESTAMPTZ,
  warming_days_at_signup INTEGER NOT NULL DEFAULT 14,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (stripe_subscription_id),
  CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due', 'canceled', 'paused'))
);

CREATE INDEX IF NOT EXISTS idx_client_subs_org_status
  ON client_subscriptions(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_client_subs_client
  ON client_subscriptions(client_id, created_at DESC);

ALTER TABLE client_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Subscriptions viewable by org members"
  ON client_subscriptions FOR SELECT
  USING (organization_id = public.get_my_org_id());

-- ============================================================
-- billing_invoices — mirror of Stripe invoices for fast rendering
-- ============================================================
CREATE TABLE IF NOT EXISTS billing_invoices (
  id TEXT PRIMARY KEY,  -- Stripe invoice id (in_...)
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_invoice_number TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  amount_paid_cents INTEGER NOT NULL DEFAULT 0,
  amount_due_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  period_start TIMESTAMPTZ,
  period_end TIMESTAMPTZ,
  hosted_invoice_url TEXT,
  invoice_pdf_url TEXT,
  issued_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status IN ('draft', 'open', 'paid', 'uncollectible', 'void'))
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_issued
  ON billing_invoices(organization_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_client
  ON billing_invoices(client_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_status
  ON billing_invoices(status);

ALTER TABLE billing_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Invoices viewable by org members"
  ON billing_invoices FOR SELECT
  USING (organization_id = public.get_my_org_id());

-- ============================================================
-- payment_links — Checkout sessions created when a quote is accepted
-- ============================================================
CREATE TABLE IF NOT EXISTS payment_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  quote_id UUID REFERENCES quotes(id) ON DELETE SET NULL,
  stripe_checkout_session_id TEXT NOT NULL,
  stripe_checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (stripe_checkout_session_id),
  CHECK (status IN ('pending', 'completed', 'expired', 'canceled'))
);

CREATE INDEX IF NOT EXISTS idx_payment_links_org_status
  ON payment_links(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_payment_links_quote
  ON payment_links(quote_id);

ALTER TABLE payment_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Payment links viewable by org members"
  ON payment_links FOR SELECT
  USING (organization_id = public.get_my_org_id());

-- ============================================================
-- stripe_events — idempotency log for webhook delivery
-- ============================================================
CREATE TABLE IF NOT EXISTS stripe_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_events_type
  ON stripe_events(event_type, processed_at DESC);

ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
-- No policies — service role only

-- ============================================================
-- Column additions
-- ============================================================
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS stripe_account_configured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_live_mode BOOLEAN NOT NULL DEFAULT false;
