-- 00132_sending_domains_critical_streak.sql
-- Require TWO consecutive critical health rollups before the domain lifecycle
-- acts on a critical band.
--
-- decideLifecycle used to tire an active domain on a single hourly rollup in
-- the 'critical' band (and to burn a rested one if its rest ended on one). A
-- single critical reading can be a blip (until 2026-09-25 a DNS resolver
-- timeout alone read as "no SPF / DMARC / MX" and could produce one), and
-- tiring costs the domain ~2 months (drain + rest + re-warm). The per-mailbox
-- auto-pause already required two consecutive sub-threshold checks; this gives
-- the domain rollup the same guard, mirroring watch_streak:
--
--   critical_streak  +1 on every hourly rollup in 'critical' (written by
--                    check-inbox-health), reset to 0 by any other band.
--                    decideLifecycle acts on critical only at >= 2
--                    (CRITICAL_STREAK_FOR_TIRED in src/lib/deliverability/lifecycle.ts).
--
-- Additive + NOT NULL DEFAULT 0 + idempotent. Safe in either deploy order: the
-- health cron only writes the column once it exists, and until then the
-- lifecycle reads it as 0 (a lone critical reading never tires a domain).

alter table public.sending_domains
  add column if not exists critical_streak integer not null default 0;

comment on column public.sending_domains.critical_streak is
  'Consecutive hourly health rollups in the critical band (migration 00132); reset to 0 by any other band. The lifecycle tires an active domain (or burns a rested one) on a critical band only at >= 2.';
