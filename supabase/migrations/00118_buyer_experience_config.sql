-- 00118_buyer_experience_config.sql
--
-- The single source of truth for the BUYER PORTAL's editable presentation: the
-- dashboard copy, how token packs are framed, empty-state text, and an optional
-- announcement banner. The admin "Buyer experience" editor writes this; the real
-- buyer pages read it (through a service-role route), so the admin preview and
-- what buyers see render the same components from the same content and can never
-- drift. Content lives as one JSONB blob merged over code defaults.
--
-- Singleton (one global content set for all buyers). Service-role only (RLS on,
-- no policy): both the admin editor and the buyer read go through service-role
-- routes. Additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.buyer_experience_config (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  content    jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO public.buyer_experience_config (singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

ALTER TABLE public.buyer_experience_config ENABLE ROW LEVEL SECURITY;
