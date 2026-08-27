-- 00090_add_native_send_variant.sql
-- A/B (and C/D…) testing: record WHICH email variant each send used, so
-- per-variant reply/positive-reply rates can be measured.
--
-- A flow email node can carry extra `variants` (migration 00086's flow_graph
-- JSONB — no schema change there). The sender deterministically assigns each
-- enrollment a variant and stamps its id here. NULL = a normal single-variant
-- send (every legacy row + every non-A/B send) — so this is inert until a
-- campaign actually A/B-tests a node.
--
-- Additive + nullable + idempotent: metadata-only, no table rewrite.

alter table public.native_sends
  add column if not exists variant_id text;

comment on column public.native_sends.variant_id is
  'A/B testing (migration 00090): the flow email variant this send used (variant A = the email node''s own id; extras = their EmailVariant id). NULL = single-variant / legacy send. Aggregated with lead_replies for per-variant reply rates.';
