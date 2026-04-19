-- Add status column to clients so we can archive former clients
-- while keeping their data (campaigns, snapshots, feedback) intact.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'former'));

CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
