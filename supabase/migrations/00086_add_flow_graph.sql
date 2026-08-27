-- 00086_add_flow_graph.sql
-- Adds the visual Flow builder's authored graph to campaigns.
--
-- The native sender continues to execute the linear `campaign_steps` (derived
-- from this graph's PRIMARY PATH — follow every condition's `no` branch). This
-- column persists the full authored tree (email/wait nodes plus the branch,
-- LinkedIn-manual and internal-automation elements) so the builder round-trips
-- even for elements the runtime does not execute yet.
--
-- Additive + nullable: a metadata-only change (no table rewrite, no lock beyond
-- a brief catalog lock) and re-runnable. Existing campaigns keep NULL and behave
-- exactly as before — the sender never reads this column.

alter table public.campaigns
  add column if not exists flow_graph jsonb;

comment on column public.campaigns.flow_graph is
  'Visual Flow builder graph (nodes + yes/no branches). The sender executes the derived linear campaign_steps; this persists the full authored tree. NULL = legacy/linear campaign.';
