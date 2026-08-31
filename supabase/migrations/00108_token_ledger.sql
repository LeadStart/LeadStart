-- 00108_token_ledger.sql
--
-- Phase 2 of the token product: the buyer token WALLET, as an append-only
-- ledger. Every movement is a row; balances are derived, never mutated in place,
-- so the wallet is auditable and the reserve -> cap -> settle flow is race-safe.
--
-- Entry types (tokens is always a positive magnitude; the type carries the sign):
--   credit   buyer bought tokens (Stripe pack)         available += tokens
--   hold     reserve worst-case retail at search start  available -= tokens; held += tokens
--   release  return the unspent part of a hold          held -= tokens; available += tokens
--   charge   settle delivered outcomes (tokens leave)    held -= tokens
-- => available = Σcredit - Σhold + Σrelease ; held = Σhold - Σrelease - Σcharge
--    total remaining = available + held = Σcredit - Σcharge.
--
-- Cash-safety (D2): the hold's retail dollar value exceeds the actor's vendor-cost
-- cap (maxTotalChargeUsd) because of the markup, so paid tokens always cover spend.
-- Idempotency (D4): one credit per Stripe session, and at most one hold/charge/
-- release per search, enforced by UNIQUE indexes so retried webhooks and
-- drain-merged / re-enriched runs can't double-count.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.token_ledger (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id          uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entry_type               text NOT NULL CHECK (entry_type IN ('credit','hold','charge','release')),
  tokens                   numeric NOT NULL CHECK (tokens >= 0),

  -- Run linkage (hold / charge / release reference the search they settle).
  search_id                uuid,
  search_kind              text CHECK (search_kind IN ('maps','linkedin')),

  -- Stripe linkage (credit entries).
  stripe_session_id        text,
  stripe_payment_intent_id text,

  -- Pricing provenance for a charge: which price-card version priced it + the
  -- retail USD value at the time (reporting / margin reconciliation only).
  price_card_version       integer,
  usd_value                numeric,

  notes                    text,
  metadata                 jsonb NOT NULL DEFAULT '{}',
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_token_ledger_org ON public.token_ledger(organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_ledger_search ON public.token_ledger(search_id) WHERE search_id IS NOT NULL;

-- Idempotency: one credit per Stripe checkout session (retried webhook is a no-op).
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_ledger_stripe_session
  ON public.token_ledger(stripe_session_id)
  WHERE stripe_session_id IS NOT NULL;

-- Idempotency: at most one hold / charge / release per search (re-settlement of a
-- drain-merged or manually re-enriched run can't double-charge or double-release).
CREATE UNIQUE INDEX IF NOT EXISTS uq_token_ledger_search_settlement
  ON public.token_ledger(search_id, entry_type)
  WHERE search_id IS NOT NULL AND entry_type IN ('hold','charge','release');

-- Derived balances per org. security_invoker so a buyer selecting the view is
-- still fenced by token_ledger's RLS to their own org.
CREATE OR REPLACE VIEW public.token_balances
  WITH (security_invoker = true) AS
SELECT
  organization_id,
  COALESCE(SUM(CASE entry_type WHEN 'credit' THEN tokens WHEN 'release' THEN tokens
                               WHEN 'hold' THEN -tokens ELSE 0 END), 0) AS available,
  COALESCE(SUM(CASE entry_type WHEN 'hold' THEN tokens WHEN 'release' THEN -tokens
                               WHEN 'charge' THEN -tokens ELSE 0 END), 0) AS held,
  COALESCE(SUM(CASE entry_type WHEN 'credit' THEN tokens WHEN 'charge' THEN -tokens
                               ELSE 0 END), 0) AS total_remaining
FROM public.token_ledger
GROUP BY organization_id;

-- RLS: a buyer reads only their own org's ledger; nobody writes via the anon/
-- authenticated role (the webhook credit + the reserve/settle flow all run
-- through the service-role client, which bypasses RLS).
ALTER TABLE public.token_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS token_ledger_buyer_read ON public.token_ledger;
CREATE POLICY token_ledger_buyer_read ON public.token_ledger
  FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() = 'buyer');
