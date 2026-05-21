-- =============================================
-- Migration 00054: per-campaign Salesforge tags + custom-var mapping
--
-- The dispatch-salesforge-enrollments cron needs to attach a tag to
-- every contact it bulk-creates (Salesforge's POST /contacts/bulk now
-- rejects untagged contacts with 422). Defaulting to "leadstart" works
-- but the operator wants to specify per-campaign tags so Salesforge's
-- segmentation reflects which LeadStart campaign each contact came
-- from.
--
-- The mapping column drives Salesforge's customVars dict. Sequence
-- step templates reference custom variables by name (e.g. {{intro}});
-- the dispatcher reads salesforge_custom_var_mapping per campaign and
-- builds the dict from the matching LeadStart contact field.
-- Example mapping: {"intro": "intro_line", "notes": "notes"} means
-- "send LeadStart's intro_line column as Salesforge's intro customVar,
-- and notes as notes". JSONB instead of a separate table because the
-- mapping is small (typically <10 entries) and rarely changes.
--
-- Both columns nullable: the dispatcher falls back to defaults when
-- they're NULL or empty (single-tag fallback + empty customVars dict).
-- =============================================

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS salesforge_default_tags TEXT[],
  ADD COLUMN IF NOT EXISTS salesforge_custom_var_mapping JSONB;
