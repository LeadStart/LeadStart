-- 00105_rate_limits.sql
--
-- Shared, cross-instance rate-limit store for the public / auth endpoints
-- (Phase 0 of the token-based contact-sourcing product). Vercel serverless
-- functions don't share memory, so the in-memory Map on /api/site-chat can't
-- stop an attacker whose requests land on different warm instances. This table
-- plus the consume_rate_limit() RPC give every instance one atomic fixed-window
-- counter to share.
--
-- Server-only: RLS enabled with NO policy (so anon / authenticated are denied),
-- table grants revoked. Only the service-role client (which bypasses RLS) and
-- the SECURITY DEFINER RPC below ever touch it — mirrors the password_reset_tokens
-- hardening in migration 00100. Idempotent; safe to re-run.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS public.rate_limits (
  bucket       TEXT        NOT NULL,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.rate_limits FROM anon, authenticated;

-- Atomic fixed-window consume: increment the counter for the current window and
-- report whether the caller is over the limit. SECURITY DEFINER so it can write
-- the table regardless of caller role (callers reach it only via the service-role
-- client). Also does a cheap opportunistic sweep of stale windows so the table
-- can't grow unbounded without a dedicated cron.
CREATE OR REPLACE FUNCTION public.consume_rate_limit(
  p_bucket         TEXT,
  p_limit          INTEGER,
  p_window_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_window_start TIMESTAMPTZ;
  v_count        INTEGER;
  v_reset        TIMESTAMPTZ;
BEGIN
  IF p_window_seconds IS NULL OR p_window_seconds < 1 THEN
    p_window_seconds := 60;
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    p_limit := 1;
  END IF;

  -- Floor now() to the window boundary so all instances agree on the bucket.
  v_window_start := to_timestamp(
    floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds
  );

  INSERT INTO public.rate_limits (bucket, window_start, count)
  VALUES (p_bucket, v_window_start, 1)
  ON CONFLICT (bucket, window_start)
  DO UPDATE SET count = public.rate_limits.count + 1
  RETURNING count INTO v_count;

  v_reset := v_window_start + make_interval(secs => p_window_seconds);

  -- ~2% of calls sweep windows older than a day.
  IF random() < 0.02 THEN
    DELETE FROM public.rate_limits WHERE window_start < now() - INTERVAL '1 day';
  END IF;

  RETURN jsonb_build_object(
    'allowed',   v_count <= p_limit,
    'count',     v_count,
    'limit',     p_limit,
    'remaining', GREATEST(0, p_limit - v_count),
    'retry_after_seconds',
      CASE WHEN v_count <= p_limit THEN 0
           ELSE GREATEST(1, ceil(extract(epoch FROM (v_reset - now())))::INTEGER)
      END,
    'reset_at',  v_reset
  );
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_rate_limit(TEXT, INTEGER, INTEGER)
  TO service_role;
