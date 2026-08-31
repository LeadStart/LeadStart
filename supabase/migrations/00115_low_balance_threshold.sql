-- 00115_low_balance_threshold.sql
--
-- Token product: a low-balance alert THRESHOLD (stub). When a buyer's available
-- token balance falls below this many tokens, a low-balance alert email should
-- fire. The SEND path is NOT wired yet — this column only persists the owner's
-- threshold so the Settings -> Tokens UI can capture it now and the alert can be
-- built on top later. NULL = disabled. Additive + idempotent.

SET search_path TO public;

ALTER TABLE public.token_pricing_config
  ADD COLUMN IF NOT EXISTS low_balance_threshold_tokens numeric;
