-- Pipeline / CRM lives on contacts — a contact IS a prospect when
-- pipeline_stage is non-null. No separate prospects table; joins are avoided,
-- querying becomes: SELECT * FROM contacts WHERE pipeline_stage IS NOT NULL.

CREATE TYPE prospect_stage AS ENUM ('lead', 'contacted', 'meeting', 'proposal', 'closed', 'lost');

ALTER TABLE contacts
  ADD COLUMN pipeline_stage prospect_stage,
  ADD COLUMN pipeline_sort_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN pipeline_notes TEXT,
  ADD COLUMN pipeline_follow_up_date DATE,
  ADD COLUMN pipeline_added_at TIMESTAMPTZ;

-- Only rows that have entered the pipeline are indexed here
CREATE INDEX idx_contacts_pipeline_stage
  ON contacts(pipeline_stage, pipeline_sort_order)
  WHERE pipeline_stage IS NOT NULL;
