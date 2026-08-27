-- Manual VA tasks — the queue behind the admin "LinkedIn to-dos" inbox.
--
-- A FlowGraph `linkedin` node (kind:'linkedin', li_kind:'connect_request'|'message')
-- is authored in the visual campaign builder but does NOT execute in the native
-- sender. Instead, when the future graph-runtime reaches such a node it will call
-- `createManualTask` (src/lib/manual-tasks/create.ts) to drop a row here, which a VA
-- works off the admin "LinkedIn to-dos" inbox by hand. This migration builds the
-- table + RLS only; NOTHING writes to it yet — the runtime hook ships in a separate
-- "graph runtime" session.
--
-- Purely additive + idempotent. Mirrors the org-scoped RLS shape of maps_searches.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS manual_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id      UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id       UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Denormalized from the campaign at creation so the inbox can show / filter by
  -- client without a second join. Nullable — a campaign may be unlinked from a client.
  client_id        UUID REFERENCES clients(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('linkedin_connect','linkedin_message')),
  -- The FlowGraph node id that spawned this task. Lets the future runtime dedup
  -- (one task per node per contact) via the unique partial index below. Nullable
  -- for tasks created by hand / outside a flow.
  flow_node_id     TEXT,
  rendered_body    TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','done','skipped')),
  assignee         UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbox: the org's OPEN tasks, newest first.
CREATE INDEX IF NOT EXISTS idx_manual_tasks_org_open
  ON manual_tasks (organization_id, created_at DESC) WHERE status = 'open';
-- General org+status browsing (Done / Skipped filters).
CREATE INDEX IF NOT EXISTS idx_manual_tasks_org_status
  ON manual_tasks (organization_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_tasks_contact ON manual_tasks (contact_id);
CREATE INDEX IF NOT EXISTS idx_manual_tasks_campaign ON manual_tasks (campaign_id);
-- Runtime idempotency: one task per (campaign, contact, flow node). Only enforced
-- when flow_node_id is set, so hand-created tasks stay unconstrained.
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_tasks_flow_node_unique
  ON manual_tasks (campaign_id, contact_id, flow_node_id) WHERE flow_node_id IS NOT NULL;

-- Keep updated_at fresh (shared trigger fn, same as tasks / contacts).
DROP TRIGGER IF EXISTS set_manual_tasks_updated_at ON manual_tasks;
CREATE TRIGGER set_manual_tasks_updated_at
  BEFORE UPDATE ON manual_tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

ALTER TABLE manual_tasks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Owners and VAs view their org's manual tasks" ON manual_tasks;
CREATE POLICY "Owners and VAs view their org's manual tasks" ON manual_tasks FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs insert their org's manual tasks" ON manual_tasks;
CREATE POLICY "Owners and VAs insert their org's manual tasks" ON manual_tasks FOR INSERT
  WITH CHECK (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs update their org's manual tasks" ON manual_tasks;
CREATE POLICY "Owners and VAs update their org's manual tasks" ON manual_tasks FOR UPDATE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));

DROP POLICY IF EXISTS "Owners and VAs delete their org's manual tasks" ON manual_tasks;
CREATE POLICY "Owners and VAs delete their org's manual tasks" ON manual_tasks FOR DELETE
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() IN ('owner','va'));
