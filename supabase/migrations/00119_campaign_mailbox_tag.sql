-- =============================================
-- Migration 00119: live mailbox-tag binding for a campaign's sending pool
--
-- Until now a campaign's sending inboxes lived ONLY as a frozen snapshot in
-- campaign_mailboxes (migration 00056): the campaign builder let an operator add
-- inboxes "by tag" (mailbox-pool-picker), but the tag was expanded to concrete
-- mailbox IDs in the browser at pick time and only those IDs were saved. Adding
-- a new inbox to that tag later did NOTHING to a campaign already built off it —
-- the operator had to reopen the picker and re-save. This mirrors Instantly's
-- convenience gap: there, a tag is a LIVE pool.
--
--   campaigns.mailbox_tag  — the ONE tag this campaign follows, or NULL for the
--                            classic manual-snapshot behavior (unchanged). When
--                            set, a reconciler (src/lib/campaigns/tag-pool-sync.ts,
--                            run on bind AND by the reconcile-campaign-tags cron)
--                            keeps campaign_mailboxes in sync with the inboxes
--                            currently carrying that tag — honoring the
--                            dedicated-inbox policy (an inbox claimed by another
--                            non-completed campaign is skipped) and refusing to
--                            empty a live pool.
--
-- Case-insensitive by convention: the tag name is matched to native_mailboxes.tags[]
-- the same way the picker groups tags (lower(name)); we store the canonical
-- display casing the operator chose.
--
-- Behavior-preserving + additive:
--   * The SEND PATH is untouched. run-native-sequences still reads
--     campaign_mailboxes verbatim; it never looks at this column. Auto-join works
--     purely by keeping that table in sync, so the hot send loop carries no new
--     risk.
--   * NULL on every existing campaign => classic manual behavior, unchanged.
--
-- No RLS change: campaigns already has org-scoped RLS (migration 00062-era); a
-- new nullable column inherits it. Clients never read campaigns directly.
-- Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00119_campaign_mailbox_tag.sql
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS mailbox_tag TEXT;

COMMENT ON COLUMN campaigns.mailbox_tag IS
  'Live mailbox-tag binding for the sending pool (migration 00119). NULL = classic manual campaign_mailboxes snapshot. When set, a reconciler keeps campaign_mailboxes in sync with the inboxes carrying this tag (case-insensitive match to native_mailboxes.tags[]), honoring the dedicated-inbox policy. The send path never reads this column.';
