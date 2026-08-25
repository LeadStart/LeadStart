-- Record the contact's location as a first-class column.
--
-- LinkedIn sourcing filters on the PERSON's profile location (where they live/
-- work — not the company's address), and we were only keeping it buried in
-- enrichment_data JSONB (source_row.location), write-only. Scrap.io-sourced
-- contacts likewise carry city/state only inside the JSONB blob. Promote it to
-- contacts.location so it's queryable/exportable, and backfill from the JSONB
-- for everything already imported. (The company's own location, when known,
-- stays under enrichment_data.enrichment.company.hq.)
--
-- Purely additive + idempotent. Apply with:
--   node scripts/supabase-sql.mjs --file supabase/migrations/00078_add_contact_location.sql

SET search_path TO public;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS location TEXT;

COMMENT ON COLUMN contacts.location IS
  'The person''s location (LinkedIn profile location, or Scrap.io city/state). NOT the company address — that lives in enrichment_data.enrichment.company.hq.';

-- Backfill from the JSONB blobs already stored:
--   1. LinkedIn-sourced: enrichment_data.source_row.location (free text)
--   2. Scrap.io-sourced: enrichment_data.city + .state (flattened business row)
--   3. Profiles-phase fallback: enrichment_data.enrichment.profile.location
UPDATE contacts
SET location = COALESCE(
  NULLIF(enrichment_data->'source_row'->>'location', ''),
  NULLIF(CONCAT_WS(', ',
    NULLIF(enrichment_data->>'city', ''),
    NULLIF(enrichment_data->>'state', '')
  ), ''),
  NULLIF(enrichment_data->'enrichment'->'profile'->>'location', '')
)
WHERE location IS NULL
  AND enrichment_data IS NOT NULL;
