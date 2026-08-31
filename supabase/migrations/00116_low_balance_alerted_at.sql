-- 00116_low_balance_alerted_at.sql
--
-- Anti-spam state for the buyer low-balance alert email. Set to now() when we
-- email a buyer that their token balance has dropped below
-- token_pricing_config.low_balance_threshold_tokens; cleared on their next
-- top-up (credit). So a buyer is alerted ONCE per crossing below the threshold,
-- not on every settle while they sit under it. NULL = not currently alerted.
-- Additive + idempotent.

SET search_path TO public;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS low_balance_alerted_at timestamptz;
