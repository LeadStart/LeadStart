-- =============================================
-- Migration 00081: Sending domains as first-class entities (burn-prevention substrate)
--
-- Until now a sending DOMAIN existed only implicitly, as the part after the @
-- in native_mailboxes.email_address. Health, DNS checks, pauses and status were
-- all per-MAILBOX, with no place to record domain-scoped facts (registrar,
-- purchase date, age, per-IP grouping, reputation) and — critically — no way to
-- express "this whole domain is tired, rest it, then re-warm it later." That
-- missing layer is what makes a domain get burned instead of rested.
--
-- This migration adds the substrate for the deliverability-infrastructure plan
-- (docs/plans/deliverability-infrastructure-plan.md, Phase 1). It is deliberately
-- BEHAVIOR-PRESERVING for the live Gmail fleet: every existing mailbox's domain
-- is backfilled as tier 'gmail', lifecycle 'active'; ramp_baseline_sent defaults
-- to 0 (so the volume-based ramp is unchanged); nothing writes any other
-- lifecycle state until the Phase 5 lifecycle cron ships. The only new machinery
-- exercised on day one is the dispatcher's step-0 drain filter, which is a no-op
-- while every domain is 'active'.
--
--   sending_domains                        — the domain registry + lifecycle +
--                                            registrar/age/IP/health metadata
--   native_mailboxes.domain_id             — FK linking each inbox to its domain
--   native_mailboxes.ramp_baseline_sent    — the RAMP-RESET mechanism: a rested
--                                            mailbox re-warms from stage 1 instead
--                                            of resuming at full cap, by offsetting
--                                            its all-time send count
--   native_mailboxes.provider CHECK        — widened to admit 'smtp' (Phase 4)
--
-- Lifecycle states (see src/lib/deliverability/lifecycle.ts for the transition
-- rules): provisioning → warming → active → tired → resting → (re-)warming …,
-- with burned / retired as terminal failure/end states.
--
-- RLS mirrors 00068 (seed_inboxes): owner/va org-scoped FOR ALL; the service
-- role (cron + admin API routes via createAdminClient) bypasses RLS entirely, so
-- the send dispatcher and health cron are unaffected. Clients never read it.
-- Apply by hand in the Supabase SQL editor (project exedxjrifprqgftyuroc).
-- =============================================

-- Make schema explicit so this migration is portable across connections whose
-- default search_path may not include `public` (matches 00056/00061/00068).
SET search_path TO public;

-- 1) The domain registry. One row per (organization, sending domain).
CREATE TABLE sending_domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                        -- lowercased bare domain, e.g. "tryleadstart.com"

  -- Which sending tier this domain belongs to. Gmail = Google Workspace inbox on
  -- Google's IPs (premium); smtp = self-hosted mail server on our own IPs (cheap,
  -- disposable). Drives ramp shape and which recipients route here.
  tier TEXT NOT NULL DEFAULT 'gmail'
    CHECK (tier IN ('gmail', 'smtp')),

  -- The burn-prevention state machine. provisioning: bought, DNS/DKIM pending,
  -- not sendable. warming: mailboxes ramping. active: full duty. tired: intake
  -- CLOSED to new leads, in-flight follow-ups drain. resting: all mailboxes
  -- paused, DNS/MX kept live so late replies still arrive. burned: DBL-listed or
  -- still failing after a full rest — never reused. retired: not renewed (terminal).
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN (
      'provisioning', 'warming', 'active', 'tired', 'resting', 'burned', 'retired'
    )),
  lifecycle_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  drain_until TIMESTAMPTZ,                      -- tired: when the drain window ends → resting
  rest_until TIMESTAMPTZ,                       -- resting: when the rest ends → (re-)warming

  -- Provisioning / accounting metadata (nullable; unknown for backfilled domains).
  registrar TEXT NOT NULL DEFAULT 'manual'
    CHECK (registrar IN ('porkbun', 'spaceship', 'manual')),
  registered_at DATE,                          -- domain registration / DNS-live date (drives age gate)
  expires_at DATE,                             -- renewal date (a resting domain must stay renewed)
  purchase_price_usd NUMERIC(10, 2),           -- feeds the registrar monthly spend cap
  dkim_verified_at TIMESTAMPTZ,                -- provisioning → warming gate (DKIM TXT observed live)
  ip_address TEXT,                             -- SMTP tier: the sending IP (groups domains for per-IP rollups)

  -- Domain-level health rollup (populated by check-inbox-health once it dedupes
  -- the per-domain DNS/DBL lookups). Mirrors the native_mailboxes.health_* shape.
  health_score INT,
  health_band TEXT CHECK (health_band IN ('healthy', 'watch', 'critical')),
  health_components JSONB,
  health_checked_at TIMESTAMPTZ,
  watch_streak INT NOT NULL DEFAULT 0,         -- consecutive daily rollups in 'watch' (→ tired at the threshold)

  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, domain)
);

-- "This org's domains in state X" — the lifecycle cron's work queue and the
-- Admin → Mailboxes domain grouping.
CREATE INDEX idx_sending_domains_org_lifecycle
  ON sending_domains (organization_id, lifecycle_status);

-- SMTP-tier per-IP rollups (blacklist + volume): "every domain on this IP".
CREATE INDEX idx_sending_domains_ip
  ON sending_domains (ip_address)
  WHERE ip_address IS NOT NULL;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON sending_domains
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 2) Link each mailbox to its domain, add the ramp-reset offset, and widen the
-- provider CHECK to admit the reserved 'smtp' value (Phase 4; nothing writes it
-- yet). The inline column CHECK from 00056 is auto-named
-- native_mailboxes_provider_check.
ALTER TABLE native_mailboxes
  ADD COLUMN domain_id UUID REFERENCES sending_domains(id) ON DELETE SET NULL,
  -- Offset subtracted from the mailbox's all-time send count before the ramp
  -- reads it. 0 = unchanged (every existing mailbox). Set to the current
  -- all-time count when re-activating a RESTED mailbox, so it re-enters the
  -- warmup ramp at stage 1 (5/day) instead of resuming at full cap. The ramp
  -- math (src/lib/gmail/ramp.ts) is untouched — the offset is applied at the
  -- dispatcher's effectiveDailyCap() call site.
  ADD COLUMN ramp_baseline_sent INT NOT NULL DEFAULT 0;

ALTER TABLE native_mailboxes
  DROP CONSTRAINT IF EXISTS native_mailboxes_provider_check;
ALTER TABLE native_mailboxes
  ADD CONSTRAINT native_mailboxes_provider_check
    CHECK (provider IN ('gmail', 'smtp'));

CREATE INDEX idx_native_mailboxes_domain
  ON native_mailboxes (domain_id)
  WHERE domain_id IS NOT NULL;

-- 3) Backfill. Create one sending_domains row per distinct (org, domain) already
-- present in native_mailboxes, then link every mailbox to it. Idempotent: the
-- INSERT skips existing rows, the UPDATE fills only NULL domain_id. All existing
-- inboxes are Gmail-tier and treated as already 'active' so nothing changes for
-- the live fleet. split_part(email,'@',2) + lower() matches domainOf() in
-- src/lib/deliverability/check.ts.
INSERT INTO sending_domains (organization_id, domain, tier, lifecycle_status, registrar)
SELECT DISTINCT
  m.organization_id,
  lower(split_part(m.email_address, '@', 2)),
  'gmail',
  'active',
  'manual'
FROM native_mailboxes m
WHERE m.email_address LIKE '%@%'
ON CONFLICT (organization_id, domain) DO NOTHING;

UPDATE native_mailboxes m
SET domain_id = d.id
FROM sending_domains d
WHERE d.organization_id = m.organization_id
  AND d.domain = lower(split_part(m.email_address, '@', 2))
  AND m.domain_id IS NULL;

COMMENT ON TABLE sending_domains IS
  'Sending domains as first-class entities: lifecycle (warming/active/tired/resting/…), registrar/age/IP metadata, and a domain-level health rollup. The burn-prevention substrate — a domain can be rested and re-warmed instead of burned.';
COMMENT ON COLUMN native_mailboxes.ramp_baseline_sent IS
  'All-time-send offset for the warmup ramp. 0 = unchanged; set to the current send count when re-activating a rested mailbox so it re-warms from stage 1.';
COMMENT ON COLUMN sending_domains.lifecycle_status IS
  'Burn-prevention state machine. tired closes intake (follow-ups drain); resting pauses all mailboxes but keeps DNS/MX live for late replies; burned/retired are terminal. Transition rules: src/lib/deliverability/lifecycle.ts.';
