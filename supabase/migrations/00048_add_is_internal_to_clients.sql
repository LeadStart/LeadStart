-- Adds an `is_internal` flag to clients and seeds one internal pseudo-client
-- per organization. The internal row represents LeadStart's own cold-email
-- outreach to acquire new clients, so the existing reply pipeline (AI
-- classifier, hot-lead notifications, reports) can run against it the same
-- way it does for paying clients. Excluded from billing/MRR; pinned to the
-- top of the campaign-linking picker.

ALTER TABLE public.clients
  ADD COLUMN is_internal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.clients.is_internal IS
  'True for the pseudo-client representing this organization''s own internal marketing outreach. Excluded from billing/MRR; pinned in the campaign-linking picker. At most one per organization.';

-- At most one internal client per organization
CREATE UNIQUE INDEX clients_one_internal_per_org_idx
  ON public.clients (organization_id)
  WHERE is_internal = true;

-- Seed one internal client for every existing organization that doesn't have one
INSERT INTO public.clients (organization_id, name, status, is_internal)
SELECT o.id, 'LeadStart — Internal Marketing', 'active', true
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.clients c
  WHERE c.organization_id = o.id AND c.is_internal = true
);
