-- =============================================
-- Migration 00111: mailbox tag registry (Settings → Tags)
--
-- Until now a mailbox tag existed only implicitly, as a string sitting in
-- native_mailboxes.tags[] (migration 00101). There was nowhere to record a tag
-- that isn't (yet) on any inbox, and no canonical spelling — so a tag couldn't
-- be pre-created, renamed org-wide, or deleted from one place. The Settings →
-- Tags manager needs exactly that: a small registry of the org's tag vocabulary,
-- independent of which inboxes currently carry each tag.
--
--   mailbox_tags   — one row per (organization, tag name). The canonical
--                    vocabulary. The manager reads the UNION of this registry
--                    and the distinct tags actually present on native_mailboxes,
--                    so ad-hoc tags added on the Mailboxes page still surface
--                    (flagged "unregistered") and can be adopted.
--
-- Rename/delete in the manager update this table AND cascade across every
-- native_mailboxes.tags[] in the org (done app-side in the route, bounded by the
-- small mailbox fleet — same per-row fan-out as /api/admin/mailboxes/tags).
--
-- Case-insensitive identity: UNIQUE (organization_id, lower(name)) mirrors the
-- picker's case-insensitive grouping (src/lib/mailboxes/tags.ts). First casing
-- wins; a pure recase is a rename, not a new tag.
--
-- Behavior-preserving: purely additive. native_mailboxes and the send path are
-- untouched. The step-5 backfill only POPULATES the new registry from tags
-- already in use, so day one the manager shows every existing tag as registered.
--
-- RLS mirrors 00068 (seed_inboxes) / 00081 (sending_domains): owner/va
-- org-scoped FOR ALL; the service role (admin API routes via createAdminClient)
-- bypasses RLS entirely. Clients never read it.
-- Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00111_create_mailbox_tags.sql
-- =============================================

SET search_path TO public;

-- 1) The registry. One row per (organization, tag name).
CREATE TABLE mailbox_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness per org (also the ON CONFLICT target for the
-- backfill below and for the manager's "add" endpoint).
CREATE UNIQUE INDEX idx_mailbox_tags_org_name
  ON mailbox_tags (organization_id, lower(name));

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON mailbox_tags
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) RLS — owner/va org-scoped FOR ALL (same shape as native_mailboxes 00062).
ALTER TABLE mailbox_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mailbox_tags_admin_all ON public.mailbox_tags;
CREATE POLICY mailbox_tags_admin_all ON public.mailbox_tags
  FOR ALL
  USING (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  )
  WITH CHECK (
    organization_id = public.get_my_org_id()
    AND public.get_my_role() IN ('owner', 'va')
  );

-- 3) Backfill the registry from tags already in use, so the manager opens
-- populated rather than showing every existing tag as "unregistered". One row
-- per distinct (org, tag); blanks skipped; case-insensitive dupes collapse via
-- the unique index (DO NOTHING). Idempotent — safe to re-run.
INSERT INTO mailbox_tags (organization_id, name)
SELECT DISTINCT m.organization_id, btrim(t.tag)
FROM native_mailboxes m,
     LATERAL unnest(m.tags) AS t(tag)
WHERE btrim(t.tag) <> ''
ON CONFLICT (organization_id, lower(name)) DO NOTHING;

COMMENT ON TABLE mailbox_tags IS
  'Mailbox tag registry (Settings → Tags): the org''s canonical tag vocabulary, independent of which inboxes carry each tag. Rename/delete cascade to native_mailboxes.tags[] in the API route. UNIQUE (organization_id, lower(name)).';
