-- =============================================
-- Migration 00039: lead_replies.idempotency_key
--
-- Per SAFETY-TODO Phase D2. Instantly's v2 API does not document an
-- Idempotency-Key header or equivalent body field on POST /emails/reply,
-- so dedup remains enforced client-side via the atomic status claim in
-- /api/replies/[id]/send. This column stores a sha256-derived key for
-- future-proofing: it's stamped when a send is attempted and persists
-- through error rollbacks so a follow-up commit can introduce an active
-- pre-check without an additional migration.
--
-- Nullable (rows ingested before D2 have no key). Partial btree index so
-- future lookups by key stay fast without bloating the table.
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_lead_replies_idempotency_key
  ON public.lead_replies(idempotency_key)
  WHERE idempotency_key IS NOT NULL;
