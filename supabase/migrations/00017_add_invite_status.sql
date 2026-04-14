-- Add invite_status column to client_users
-- 'pending' = invited but hasn't accepted yet
-- 'active' = accepted invite and set password
ALTER TABLE public.client_users
  ADD COLUMN invite_status TEXT NOT NULL DEFAULT 'active';

-- Existing rows are already active users
-- New invites will be inserted with 'pending'
