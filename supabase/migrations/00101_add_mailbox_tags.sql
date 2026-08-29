-- Free-form tags on sending inboxes (Instantly-style mailbox tags). A tag is a
-- named pool the operator assigns to inboxes on Admin → Mailboxes; the campaign
-- mailbox picker then offers "add every inbox with tag X" so a whole category can
-- be attached at once. Tags are arbitrary strings that can span domains (e.g.
-- "Agency", "Client A warm pool"), complementing the auto-derived domain grouping
-- (native_mailboxes.domain_id) which the picker also groups by.
--
-- Mirrors the contacts.tags TEXT[] precedent (migration 00010): a plain text
-- array, NOT NULL DEFAULT '{}' so every row (new + existing) reads as an empty
-- list with no backfill. Purely additive + idempotent.
--
-- Security: no per-column grant work needed. native_mailboxes is admin-client
-- only (owner endpoints + cron); RLS on it (migration 00062) already gates access.

SET search_path TO public;

ALTER TABLE native_mailboxes
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN index so "which inboxes carry tag X" (tag = ANY(tags) / tags @> ARRAY[x])
-- stays cheap once there are many inboxes and tags.
CREATE INDEX IF NOT EXISTS idx_native_mailboxes_tags
  ON native_mailboxes USING GIN (tags);
