-- =============================================
-- Migration 00057: per-contact custom merge fields
--
-- The native email engine (run-native-sequences) renders sequence copy
-- against a contact's columns — {{first_name}}, {{company}}, etc. Those
-- cover the standard CRM fields, but real campaigns carry arbitrary
-- per-recipient data that has no dedicated column: a real-estate agent
-- outreach needs {{PropertyAddress}} and {{SoldDate}}; a different niche
-- needs something else entirely.
--
-- Rather than bolt a new typed column on for every campaign, custom_fields
-- is a small JSONB bag of "variable name -> value" that the renderer falls
-- back to for any {{token}} it doesn't recognize as a standard field. The
-- CSV importer drops any non-standard column into this bag, and the
-- renderer matches tokens case/format-insensitively (PropertyAddress ~=
-- property_address ~= "Property Address").
--
-- Kept separate from enrichment_data on purpose: enrichment_data is owned
-- by the decision-maker enrichment worker and gets overwritten by it;
-- custom_fields is campaign merge data the operator imports and the sender
-- reads. Conflating them would let the enrichment worker clobber merge
-- variables mid-campaign.
--
-- NOT NULL DEFAULT '{}' so the renderer can read it unconditionally without
-- a null guard, matching the enrichment_data / tags stance on this table.
-- =============================================

SET search_path TO public;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
