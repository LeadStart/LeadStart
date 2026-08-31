-- 00117_buyer_reverify_jobs.sql
--
-- Async buyer RE-VERIFY. A buyer enqueues a job to re-check their stale verified
-- emails; the reverify-buyer-contacts cron drains it in batches via Million
-- Verifier (the platform's key), charging reverify_token_price per re-checked
-- contact through the token hold -> charge -> release flow (keyed by the job id).
-- Synchronous re-verify would time out on a large list, hence the job + cron.
--
-- One ACTIVE (pending/running) job per org at a time (partial unique index).
-- Buyer-read RLS; every write goes through the service-role routes/cron.
-- Additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.buyer_reverify_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by      uuid,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','failed')),
  contact_ids     uuid[] NOT NULL DEFAULT '{}',  -- the snapshot the cron works through
  total           integer NOT NULL DEFAULT 0,    -- stale contacts at enqueue (the cap)
  processed       integer NOT NULL DEFAULT 0,    -- contacts MV has re-checked
  reverified      integer NOT NULL DEFAULT 0,    -- definitive verdicts (the charge basis)
  reverify_price  numeric,                       -- tokens per re-check, snapshotted at enqueue
  charged         integer,                       -- tokens charged at completion
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Idempotent add for an already-applied table (CREATE above is a no-op then).
ALTER TABLE public.buyer_reverify_jobs
  ADD COLUMN IF NOT EXISTS contact_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_buyer_reverify_jobs_org
  ON public.buyer_reverify_jobs(organization_id, created_at DESC);

-- At most one active job per org: a repeat enqueue while one is in flight 23505s.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buyer_reverify_active
  ON public.buyer_reverify_jobs(organization_id)
  WHERE status IN ('pending', 'running');

ALTER TABLE public.buyer_reverify_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS buyer_reverify_jobs_buyer_read ON public.buyer_reverify_jobs;
CREATE POLICY buyer_reverify_jobs_buyer_read ON public.buyer_reverify_jobs
  FOR SELECT
  USING (organization_id = public.get_my_org_id() AND public.get_my_role() = 'buyer');
