-- =============================================
-- Migration: Add reclassify audit columns to lead_replies
-- Companion to commit #9 of the AI reply-routing rollout.
-- Captures the "who/when/from-what" trail when an owner/VA overrides the
-- classifier's output on a reply. One row per reply, so this only records
-- the most recent reclassify; if we ever need full history we'll add a
-- separate admin_audit_log table.
-- =============================================

ALTER TABLE public.lead_replies
  ADD COLUMN IF NOT EXISTS reclassified_by UUID
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reclassified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclassified_from TEXT;

COMMENT ON COLUMN public.lead_replies.reclassified_by IS
  'User id of the owner/VA who last overrode the classifier. NULL for replies never manually reclassified.';
COMMENT ON COLUMN public.lead_replies.reclassified_at IS
  'Timestamp of the most recent manual reclassification.';
COMMENT ON COLUMN public.lead_replies.reclassified_from IS
  'The final_class value that was replaced by the most recent manual reclassification. NULL until first override.';
