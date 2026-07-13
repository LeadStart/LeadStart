-- 00063: Drop the dead Salesforge/Warmforge schema objects.
--
-- Native Gmail is now the sole email channel. All Salesforge/Warmforge code was
-- pruned in commit e7a60ba, so these columns and the enrollment-queue table are
-- no longer read or written by anything.
--
-- Pre-drop audit (2026-07-13, via scripts/audit-salesforge-warmforge-dead-columns.mjs):
--   * 10 of 12 target columns were 100% NULL.
--   * campaigns.salesforge_sequence_id held 2 dead ids (SaaSassins Janitorial,
--     PolishPoint Janitorial — both defunct source_channel='salesforge' campaigns).
--   * salesforge_enrollment_queue held 316 undrained rows (its dispatcher cron
--     was deleted, so nothing consumes them).
--   * contacts.salesforge_contact_id held 315 dead ids (its two indexes,
--     idx_contacts_salesforge_contact_id + idx_contacts_org_salesforge_contact_unique,
--     drop with the column).
-- All of it was snapshotted to backups/salesforge-warmforge-<ts>.json before this ran.
--
-- Idempotent: every drop is IF EXISTS, so re-running is a no-op. DROP COLUMN
-- also removes any index/constraint that referenced only that column; DROP TABLE
-- removes the queue table's own indexes + RLS policies.

BEGIN;

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS salesforge_api_key,
  DROP COLUMN IF EXISTS salesforge_workspace_id,
  DROP COLUMN IF EXISTS salesforge_default_product_id,
  DROP COLUMN IF EXISTS warmforge_api_key;

ALTER TABLE public.campaigns
  DROP COLUMN IF EXISTS salesforge_sequence_id,
  DROP COLUMN IF EXISTS salesforge_daily_contact_cap,
  DROP COLUMN IF EXISTS salesforge_default_tags,
  DROP COLUMN IF EXISTS salesforge_custom_var_mapping;

ALTER TABLE public.lead_replies
  DROP COLUMN IF EXISTS salesforge_email_id,
  DROP COLUMN IF EXISTS salesforge_thread_id,
  DROP COLUMN IF EXISTS salesforge_mailbox_id;

ALTER TABLE public.contacts
  DROP COLUMN IF EXISTS salesforge_contact_id;

DROP TABLE IF EXISTS public.salesforge_enrollment_queue;

COMMIT;
