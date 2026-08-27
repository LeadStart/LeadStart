-- 00089_add_enrollment_node_position.sql
-- Graph-runtime phase (#3): give an enrollment a position INSIDE the flow graph.
--
-- Today the native sender walks the derived linear `campaign_steps` and tracks
-- position with `campaign_enrollments.current_step_index`. This phase makes the
-- sender walk `campaigns.flow_graph` directly (branching, LinkedIn-manual and
-- internal-automation nodes execute), so an enrollment needs to remember WHICH
-- node in the tree it last acted on. `current_node_id` holds that FlowGraph node
-- id (a text id, not a UUID FK — flow node ids are crypto.randomUUID / n_<counter>).
--
-- Feature-detection / zero-regression contract:
--   * flow_graph IS NULL (legacy/linear campaigns)  -> the sender ignores this
--     column entirely and keeps using current_step_index exactly as before.
--   * flow_graph present, current_node_id IS NULL    -> a fresh (or pre-migration
--     in-flight) enrollment: the runtime resolves the resume point from
--     current_step_index (# of emails already sent on the primary path) so no
--     email is ever re-sent, then stamps current_node_id from that tick on.
--   * flow_graph present, current_node_id set         -> resume the walk after
--     that node.
--
-- current_step_index stays meaningful for flow campaigns too: it continues to
-- count EMAILS sent (0 = first touch), which the send machinery keys off
-- (subject/threading, new-leads cap, sticky mailbox). Only email nodes bump it.
--
-- Additive + nullable + idempotent: a metadata-only change (no table rewrite,
-- no lock beyond a brief catalog lock) and re-runnable. Existing rows keep NULL.

alter table public.campaign_enrollments
  add column if not exists current_node_id text;

comment on column public.campaign_enrollments.current_node_id is
  'Graph-runtime position (migration 00089): the campaigns.flow_graph node id whose action this enrollment last executed. NULL on legacy/linear campaigns (sender uses current_step_index) and on fresh flow enrollments (runtime resolves the resume point from current_step_index until the first flow tick stamps it).';
