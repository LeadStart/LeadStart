-- Onboarding/billing redesign: retire pricing tiers → every quote is ad-hoc.
--
-- Quotes gain a per-quote warming window (set by us at send time, no longer a
-- hardcoded 14) and an optional contact-sourcing line item. Subscriptions
-- snapshot the monthly + contact pricing so the admin billing page can render
-- MRR and amounts WITHOUT a pricing_plans row (there are no plans to read now).
--
-- Purely additive + idempotent. `warming_days` defaults to 14 so existing rows
-- keep their prior behaviour.

SET search_path TO public;

-- ---- quotes: ad-hoc levers ----
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS warming_days INTEGER NOT NULL DEFAULT 14;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS contacts_count INTEGER;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS contact_sourcing_cents INTEGER NOT NULL DEFAULT 0;

-- ---- client_subscriptions: pricing snapshot (tiers retired) ----
ALTER TABLE client_subscriptions ADD COLUMN IF NOT EXISTS monthly_price_cents INTEGER;
ALTER TABLE client_subscriptions ADD COLUMN IF NOT EXISTS contact_sourcing_cents INTEGER;
ALTER TABLE client_subscriptions ADD COLUMN IF NOT EXISTS contacts_count INTEGER;
