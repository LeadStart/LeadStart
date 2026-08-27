-- 00091_add_ab_auto_pause_default.sql
-- A/B auto-winner: a per-CAMPAIGN default for whether losing variants auto-pause.
--
-- The auto-winner is opt-in (off by default). Each A/B email node can force it
-- on/off via flow_graph JSONB (EmailNode.ab_config.autoPause); when a node
-- leaves that unset it INHERITS this campaign-level default. So the resolution
-- is: node override -> this campaign default -> false.
--
-- Additive + NOT NULL DEFAULT false + idempotent: metadata-only, inert until a
-- campaign turns it on AND the code that reads it deploys.

alter table public.campaigns
  add column if not exists ab_auto_pause_default boolean not null default false;

comment on column public.campaigns.ab_auto_pause_default is
  'A/B auto-winner (migration 00091): campaign-level default for auto-pausing losing variants. A flow email node inherits this unless its ab_config.autoPause overrides. Off by default.';
