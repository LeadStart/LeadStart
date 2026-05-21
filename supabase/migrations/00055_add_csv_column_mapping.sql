-- Migration 00055: per-campaign CSV column mapping
--
-- Stores the user's chosen mapping from CSV header names to LeadStart
-- contact fields. Persisted per campaign so re-uploads to the same
-- campaign pre-populate the mapping UI with the previous choices.
--
-- Shape: { "CSV Header Name": "first_name", "Email Address": "email", ... }
-- NULL = no mapping saved yet (import panel falls back to auto-detect).

SET search_path TO public;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS csv_column_mapping JSONB;
