-- 00133_native_mailboxes_signature.sql
-- Per-inbox sending identity (owner, 2026-09-27): every inbox carries its own
-- name (display_name), its own signature (this column) and its own warmup
-- cadence (the ramp_* columns).
--
--   signature  {{signature}} in campaign copy resolves to the SENDING inbox's
--              signature; a {{your_name}} inside it is filled from that inbox's
--              display_name (src/lib/native/tokens.ts resolveSignature). NULL /
--              blank = no signature set: {{signature}} falls back to the inbox's
--              name, so a send is never unsigned.
--
-- Additive + nullable + idempotent. Safe in either deploy order: the sender and
-- the preview read native_mailboxes with select('*'), so a missing column reads
-- as "no signature" until this runs.

ALTER TABLE public.native_mailboxes
  ADD COLUMN IF NOT EXISTS signature TEXT;

COMMENT ON COLUMN public.native_mailboxes.signature IS
  'Plain-text signature this inbox signs with ({{signature}}); may contain {{your_name}}. NULL = sign with the inbox name.';
