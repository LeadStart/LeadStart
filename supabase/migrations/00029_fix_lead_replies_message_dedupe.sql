-- 00029: Convert idx_lead_replies_message_dedupe from a partial unique INDEX
-- into a regular UNIQUE CONSTRAINT.
--
-- Why: the webhook handler's upsert path uses
--   ON CONFLICT (organization_id, instantly_message_id) DO UPDATE
-- but Postgres can't match a partial index (WHERE ... IS NOT NULL) without
-- the partial predicate appearing in the ON CONFLICT clause. PostgREST /
-- supabase-js doesn't expose a way to add that predicate, so every
-- reply_received insert was failing with 42P10
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
-- and silently being swallowed by the handler.
--
-- A regular UNIQUE constraint solves the upsert path. Postgres treats NULLs
-- as distinct in unique constraints by default, so multiple rows with NULL
-- instantly_message_id remain allowed (matching the partial index's old
-- behaviour for that case).

DROP INDEX IF EXISTS public.idx_lead_replies_message_dedupe;

ALTER TABLE public.lead_replies
  ADD CONSTRAINT lead_replies_message_dedupe UNIQUE (organization_id, instantly_message_id);
