-- Contact person on a client: first + last name, so quotes and notifications can
-- greet the recipient by first name (the company name lives in clients.name).
-- Additive + idempotent; existing rows keep NULL and fall back to a generic greeting.

SET search_path TO public;

ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_first_name TEXT;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS contact_last_name TEXT;
