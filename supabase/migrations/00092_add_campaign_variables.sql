-- 00092_add_campaign_variables.sql
-- Adds the persisted per-campaign variable registry.
--
-- This is the single SOURCE OF TRUTH for which merge variables a campaign
-- expects while it is building or in flight — the schema half of the
-- Instantly-style contact-list ↔ campaign alignment. It is reconciled from two
-- inputs and never derived from copy alone:
--   * the {{tokens}} the campaign's copy uses (all A/B variants, both branches), and
--   * the custom columns a CSV/CRM ingest maps into the campaign.
-- Values stay in contacts.custom_fields; campaign_enrollments remains WHO
-- receives. See src/lib/native/tokens.ts (reconcileCampaignVariables).
--
-- Shape: an ordered JSON array of
--   { "token": string, "key": string, "kind": "standard"|"custom", "fields"?: string[] }
-- `token` is the canonical spelling, `key` = normalizeVarKey(token) (the identity
-- used for de-dupe + resolution), `kind` groups standard contact fields vs custom
-- vars, `fields` (standard only) names the contact columns that satisfy the token.
--
-- Additive + NOT NULL DEFAULT '[]': a metadata-only change (no table rewrite),
-- re-runnable. Existing campaigns get an empty registry; the import bootstrap
-- reconciles it from copy on read, and the next sequence save persists it.

alter table public.campaigns
  add column if not exists variables jsonb not null default '[]'::jsonb;

comment on column public.campaigns.variables is
  'Campaign variable registry (schema): ordered [{token,key,kind,fields?}] of the merge variables this campaign expects, reconciled from copy tokens + mapped list columns. Values live in contacts.custom_fields. Defaults to [].';
