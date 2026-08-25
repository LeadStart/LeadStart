-- Separate company-level contact data from the decision-maker's own details.
--
-- Site-scrape + the harvestapi company actor surface COMPANY-level contact info
-- (the main published line, a generic info@/contact@ inbox). Those were being
-- written into contacts.phone (conflating the company line with the person's
-- direct number) and buried in the enrichment_data JSONB. Give them explicit,
-- clearly-labeled columns so contacts.email / contacts.phone stay reserved for
-- the decision-maker's personal details.
--
-- Purely additive + idempotent. Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00076_add_contact_company_fields.sql

SET search_path TO public;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS company_phone TEXT,
  ADD COLUMN IF NOT EXISTS company_email TEXT;

COMMENT ON COLUMN contacts.company_phone IS
  'Company main/published phone line (site scrape or harvestapi company). NOT the decision-maker''s direct number — that lives in contacts.phone.';
COMMENT ON COLUMN contacts.company_email IS
  'Generic company inbox (info@/contact@) from a site scrape. NOT the decision-maker''s personal address — that lives in contacts.email.';
