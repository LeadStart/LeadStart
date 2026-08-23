-- =============================================
-- Migration 00069: Pre-send email verification (Million Verifier)
--
-- Closes the #1 evidence-backed deliverability gap for the native Gmail
-- channel: until now no recipient address was verified before it was sent to.
-- Bad addresses were only discovered as hard bounces — exactly the signal the
-- inbox-health score punishes. Verification was a manual, out-of-band step
-- (run a CSV through millionverifier.com, delete the rest).
--
-- This adds a just-in-time gate inside run-native-sequences: every recipient is
-- verified against the Million Verifier real-time API immediately before its
-- first send, the result is cached on the contact (30-day TTL, so follow-ups
-- reuse it for free), undeliverable addresses are never sent, and the verifier's
-- credit balance + availability are surfaced to the owner.
--
--   organizations.millionverifier_*  — per-org API key + last-seen credits +
--                                       account-error state (drives the 1h
--                                       call-suppression + owner alerts)
--   contacts.email_verification_*     — the cached per-address result. Orthogonal
--                                       to contacts.status (the dispatch
--                                       lifecycle enum is left untouched).
--   native_sends.email_verification_result
--                                     — snapshot of what the gate saw at send
--                                       time, so bounce rate can later be sliced
--                                       by result to validate the catch-all policy
--
-- The contacts.email_verification_* columns are deliberately NOT part of the
-- contact_status enum: an invalid/risky verdict is orthogonal to where a contact
-- sits in the queued -> uploaded -> active dispatch progression, and overloading
-- the enum would collide with the send loop's suppression + import gates.
--
-- No RLS changes: the new columns ride the existing row policies on
-- organizations / contacts / native_sends. Service-role (cron + admin routes via
-- createAdminClient) bypasses RLS as before.
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

SET search_path TO public;

-- 1) Per-org Million Verifier credentials + state. Mirrors the other vendor
-- keys (plaintext TEXT on organizations, same trust boundary). The error trio
-- drives call suppression: after a *definitive* account error (bad key / no
-- credits / IP blocked) the cron stops calling for 1h and alerts the owner;
-- credits are cached so a low balance can be alerted without an extra API call.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS millionverifier_api_key TEXT,
  ADD COLUMN IF NOT EXISTS millionverifier_credits INT,
  ADD COLUMN IF NOT EXISTS millionverifier_credits_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS millionverifier_last_error TEXT,
  ADD COLUMN IF NOT EXISTS millionverifier_last_error_kind TEXT
    CHECK (millionverifier_last_error_kind IN ('auth', 'credits', 'blocked', 'transient')),
  ADD COLUMN IF NOT EXISTS millionverifier_last_error_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS millionverifier_error_streak INT NOT NULL DEFAULT 0;

-- 2) Cached per-contact verification result. `email_verified_at` stamps the last
-- stored API result (any result, not only 'ok') and drives the 30-day freshness
-- TTL. `email_verification_attempts` bounds the retry loop for indeterminate
-- results (unknown / per-address error) so a greylisting mail server can't make
-- a contact retry forever.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS email_verification_status TEXT
    CHECK (email_verification_status IN ('ok', 'catch_all', 'unknown', 'invalid', 'disposable', 'error')),
  ADD COLUMN IF NOT EXISTS email_verification_subresult TEXT,
  ADD COLUMN IF NOT EXISTS email_verification_quality TEXT
    CHECK (email_verification_quality IN ('good', 'bad', 'risky')),
  ADD COLUMN IF NOT EXISTS email_is_free BOOLEAN,
  ADD COLUMN IF NOT EXISTS email_is_role BOOLEAN,
  ADD COLUMN IF NOT EXISTS email_did_you_mean TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_verification_attempts INT NOT NULL DEFAULT 0;

-- A change of address invalidates any cached verdict. Fire only on a real
-- address change (case-insensitive) so the admin edit dialog's routine writes
-- and case-only fixes don't wipe a valid result. The gate's own UPDATE never
-- touches `email`, so it never trips this. Coexists with set_contacts_updated_at
-- (both are BEFORE UPDATE row triggers editing NEW).
CREATE OR REPLACE FUNCTION public.reset_email_verification_on_email_change()
RETURNS TRIGGER AS $$
BEGIN
  NEW.email_verification_status := NULL;
  NEW.email_verification_subresult := NULL;
  NEW.email_verification_quality := NULL;
  NEW.email_is_free := NULL;
  NEW.email_is_role := NULL;
  NEW.email_did_you_mean := NULL;
  NEW.email_verified_at := NULL;
  NEW.email_verification_attempts := 0;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reset_email_verification ON contacts;
CREATE TRIGGER reset_email_verification
  BEFORE UPDATE OF email ON contacts
  FOR EACH ROW
  WHEN (lower(OLD.email) IS DISTINCT FROM lower(NEW.email))
  EXECUTE FUNCTION public.reset_email_verification_on_email_change();

-- The send loop's verification gate reads this per org when deciding whether a
-- cached verdict is still fresh; the partial index keeps the "how many contacts
-- are invalid/risky/unverified" admin counters cheap.
CREATE INDEX IF NOT EXISTS idx_contacts_org_email_verification
  ON contacts (organization_id, email_verification_status)
  WHERE email_verification_status IS NOT NULL;

-- 3) Snapshot on the send log what the gate saw at send time. Only ever set for
-- results that actually send (ok / catch_all / unknown-after-retries); NULL means
-- the gate was disarmed (no key configured) when this row was written. Lets us
-- later slice the bounce rate by verification result to validate the "send
-- catch-all, flag risky" policy against real outcomes.
ALTER TABLE native_sends
  ADD COLUMN IF NOT EXISTS email_verification_result TEXT
    CHECK (email_verification_result IN ('ok', 'catch_all', 'unknown'));

COMMENT ON COLUMN contacts.email_verification_status IS
  'Cached Million Verifier verdict for contacts.email (30-day TTL via email_verified_at). Orthogonal to contacts.status; drives the pre-send gate in run-native-sequences.';
COMMENT ON COLUMN contacts.email_verified_at IS
  'When the last Million Verifier result (any result) was stored for this address. Drives the 30-day freshness TTL and is cleared by the email-change trigger.';
COMMENT ON COLUMN organizations.millionverifier_api_key IS
  'Million Verifier real-time API key (per org, plaintext — same trust boundary as the other vendor keys). NULL disarms the pre-send verification gate (sends proceed unverified).';
COMMENT ON COLUMN native_sends.email_verification_result IS
  'What the pre-send verification gate saw at send time (ok/catch_all/unknown). NULL = gate disarmed. Slice bounce rate by this to validate the catch-all policy.';
