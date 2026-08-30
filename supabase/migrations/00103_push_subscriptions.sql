-- Web-push subscriptions for hot-lead reply notifications. Each row is one
-- browser/device push endpoint a user opted into (the Add-to-Home-Screen PWA on
-- iOS 16.4+, or a desktop browser). When a hot lead reply is classified, the
-- reply pipeline (src/lib/replies/pipeline.ts → src/lib/notifications/web-push.ts)
-- fans a push out to every subscription in that reply's organization so an admin
-- can respond on the move. Purely additive + idempotent.

SET search_path TO public;

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  organization_id UUID,
  endpoint        TEXT NOT NULL,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ
);

-- One row per browser push endpoint. Re-subscribing (same device) upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_subscriptions_endpoint
  ON push_subscriptions (endpoint);
-- The send path fans out by organization.
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_org
  ON push_subscriptions (organization_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions (user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- A user manages only their own subscriptions from the app (SSR client, RLS on).
-- The reply pipeline reads via the service role (bypasses RLS) to fan a hot-lead
-- push out to the whole org.
DROP POLICY IF EXISTS "Users manage own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users manage own push subscriptions" ON push_subscriptions
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
