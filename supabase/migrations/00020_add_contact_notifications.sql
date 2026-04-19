-- Add a per-profile flag controlling which admins receive contact-form
-- submissions from the marketing site. Managed in-app via Settings > Team.
ALTER TABLE public.profiles
  ADD COLUMN receives_contact_notifications BOOLEAN NOT NULL DEFAULT false;

-- Seed: every existing owner opts in by default, so nothing breaks the day
-- this migration lands. New owners invited after today default to false
-- and must be toggled on explicitly.
UPDATE public.profiles
  SET receives_contact_notifications = true
  WHERE role = 'owner';

-- Partial index for the contact endpoint's lookup:
--   WHERE receives_contact_notifications = true AND role = 'owner' AND is_active
CREATE INDEX idx_profiles_contact_recipients
  ON public.profiles (role, is_active)
  WHERE receives_contact_notifications = true;
