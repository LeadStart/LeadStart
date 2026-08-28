-- Shared geo reference gazetteer for the prospecting location pickers. A single
-- dictionary of place names (country / state / county / city) that BOTH veins'
-- pickers query for type-ahead + confirmatory disambiguation:
--   - Maps (this build): city / county / state / zip — zip is digit-detected, not
--     stored here; county+state disambiguate ("which Dallas County?").
--   - LinkedIn (future fork): country / state / city — reuses this same table,
--     replacing the retiring Scrap.io location type-ahead.
-- This is shared REFERENCE data, not shared vein logic — the veins stay separate
-- (each maps a picked place to its OWN actor's geo fields). Seeded from the US
-- Census reference files (states + ~3.1k counties + ~19k incorporated cities) by
-- scripts/seed-geo-places.mjs. Read-only for the app; NOT app-bundled — the
-- picker fetches ~10 matches per keystroke from the geo-typeahead endpoint.
-- Purely additive + idempotent.

SET search_path TO public;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS geo_places (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('country','state','county','city')),
  name         TEXT NOT NULL,          -- display name: "Dallas County", "Austin", "Texas"
  state_code   TEXT,                   -- USPS 2-letter for state/county/city; NULL for country
  state_name   TEXT,                   -- full state name (denormalized for display + actor input)
  country_code TEXT NOT NULL DEFAULT 'us',  -- ISO-2
  fips         TEXT,                   -- 2-digit state FIPS / 5-digit county FIPS; NULL for city/country
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Prefix type-ahead: lower(name) LIKE 'aus%' rides this btree (jumps straight to
-- the matching names instead of scanning the table).
CREATE INDEX IF NOT EXISTS idx_geo_places_name_prefix
  ON geo_places (lower(name) text_pattern_ops);
-- Each picker filters to the kinds it supports.
CREATE INDEX IF NOT EXISTS idx_geo_places_kind ON geo_places (kind);
-- Substring / typo-tolerant matches ("contains").
CREATE INDEX IF NOT EXISTS idx_geo_places_name_trgm
  ON geo_places USING gin (name gin_trgm_ops);
-- Idempotent-seed / dedupe key (state_code NULL only for country rows).
CREATE UNIQUE INDEX IF NOT EXISTS idx_geo_places_natural
  ON geo_places (kind, lower(name), COALESCE(state_code, ''), country_code);

ALTER TABLE geo_places ENABLE ROW LEVEL SECURITY;

-- Public, non-sensitive reference data: any authenticated user may read. Writes
-- happen only via the service role (seed script), which bypasses RLS — there is
-- deliberately no INSERT/UPDATE/DELETE policy.
DROP POLICY IF EXISTS "Authenticated users read geo places" ON geo_places;
CREATE POLICY "Authenticated users read geo places" ON geo_places FOR SELECT
  TO authenticated USING (true);
