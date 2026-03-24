-- Seed data for local development
-- Run after migrations with: supabase db reset

-- Create the organization
INSERT INTO public.organizations (id, name)
VALUES ('00000000-0000-0000-0000-000000000001', 'LeadStart');

-- NOTE: The owner user must be created through Supabase Auth.
-- After running `supabase start`, create the owner via the Supabase Dashboard
-- at http://localhost:54323 or via the CLI:
--
--   1. Go to Authentication > Users > Add User
--   2. Email: admin@leadstart.com, Password: password123
--   3. Then manually update their profile:
--
-- UPDATE public.profiles SET role = 'owner', organization_id = '00000000-0000-0000-0000-000000000001'
-- WHERE email = 'admin@leadstart.com';

-- Sample clients (will be linked once you set up)
INSERT INTO public.clients (id, organization_id, name, contact_email) VALUES
  ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'Acme Corp', 'john@acmecorp.com'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'TechStartup Inc', 'sarah@techstartup.io');

-- Sample campaigns (replace instantly_campaign_id with real IDs from your Instantly account)
INSERT INTO public.campaigns (id, client_id, organization_id, instantly_campaign_id, name, status) VALUES
  ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001', 'REPLACE_WITH_REAL_ID_1', 'Acme Corp - Q1 Outreach', 'active'),
  ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000001', 'REPLACE_WITH_REAL_ID_2', 'TechStartup - Decision Makers', 'active');
