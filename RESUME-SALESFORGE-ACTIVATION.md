# RESUME: Salesforge AI Reply Pipeline — Activation

> **Status:** all code shipped. Pipeline is gated on three things you do in dashboards: apply migrations, add API keys, register a webhook. Walks you through the test-campaign smoke test before you point this at a real client.
>
> The earlier `RESUME-AI-REPLY-ROUTING.md` was deleted when the Instantly integration was stripped (migration `00051_drop_instantly_schema.sql`). This doc is the only resume reference for the reply pipeline.
>
> **Delete this file once activation is verified working in production.** Note in the deletion commit which test client / campaign was used.

---

## What activation actually is

The end-to-end flow we're proving out:

1. Salesforge sequence sends an email to a seeded test prospect
2. Test prospect replies
3. Salesforge fires a webhook at `POST /app/api/webhooks/salesforge?secret=…`
4. Handler [`src/app/api/webhooks/salesforge/route.ts`](src/app/api/webhooks/salesforge/route.ts) writes a row to `lead_replies` with `source_channel='salesforge'`
5. After-handler runs the reply pipeline (`runReplyPipeline` in [`src/lib/replies/pipeline.ts`](src/lib/replies/pipeline.ts)) — Claude classifies it
6. If `final_class` is in `clients.auto_notify_classes`, Resend fires a hot-lead email to `clients.notification_email`
7. Row shows up in `/admin/inbox` and `/client/inbox` for the client

Any step that fails surfaces as a missing row, a stuck `notification_status='pending'`, or a logged exception in Vercel.

---

## Step 1 — apply migrations

Four migrations underpin this initiative:

| Migration | What it adds | Why it's needed |
|-----------|--------------|-----------------|
| `00021_create_campaign_step_metrics.sql` | `campaign_step_metrics` table | Fixes the per-load 404 every dashboard fires; not strictly required for the pipeline but you'll see it on every page until applied |
| `00045_add_source_channel.sql` | `source_channel` ENUM + columns on `campaigns`, `lead_replies`, `webhook_events` | Channel discriminator. Salesforge replies need this to be tagged `salesforge`. |
| `00049_add_salesforge_columns.sql` | `salesforge_*` columns on `organizations`, `campaigns`, `lead_replies`; extends ENUM with `'salesforge'` | API key storage + per-sequence/per-reply id plumbing |
| `00050_create_salesforge_enrollment_queue.sql` | `salesforge_enrollment_queue` table + `campaigns.salesforge_daily_contact_cap` | Salesforge has no native cap on new-contacts-per-day. Push-to-campaign now writes here instead of calling Salesforge synchronously; the once-daily `dispatch-salesforge-enrollments` cron (15:00 UTC ≈ 8am Pacific) drains it at the per-campaign cap. Default cap = 66 (sized for 3-step sequence on 200 sends/day). |

### Pre-flight check

Paste this in [Supabase SQL editor for `exedxjrifprqgftyuroc`](https://supabase.com/dashboard/project/exedxjrifprqgftyuroc/sql/new). Returns one row of true/false so you know what's missing:

```sql
select
  (to_regclass('public.campaign_step_metrics') is not null) as has_step_metrics_table_00021,
  (exists(select 1 from pg_type where typname = 'source_channel')) as has_source_channel_enum_00045,
  exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='campaigns' and column_name='source_channel'
  ) as has_campaigns_source_channel_00045,
  exists(
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'source_channel' and e.enumlabel = 'salesforge'
  ) as has_salesforge_enum_value_00049,
  exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='organizations' and column_name='salesforge_api_key'
  ) as has_org_salesforge_keys_00049,
  exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='lead_replies' and column_name='salesforge_email_id'
  ) as has_lead_replies_salesforge_00049,
  (to_regclass('public.salesforge_enrollment_queue') is not null) as has_enrollment_queue_00050,
  exists(
    select 1 from information_schema.columns
    where table_schema='public' and table_name='campaigns' and column_name='salesforge_daily_contact_cap'
  ) as has_campaigns_daily_cap_00050;
```

### Safe-to-paste apply block

The original migration files are not all idempotent. The block below rewrites each non-idempotent op with `IF NOT EXISTS` / `DO $$` guards so it's safe to paste regardless of which pieces are already applied. Paste the whole thing in one shot:

```sql
-- =============================================================
-- 00021 — campaign_step_metrics
-- =============================================================
CREATE TABLE IF NOT EXISTS campaign_step_metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  unique_replies INTEGER NOT NULL DEFAULT 0,
  opens INTEGER NOT NULL DEFAULT 0,
  unique_opens INTEGER NOT NULL DEFAULT 0,
  bounces INTEGER NOT NULL DEFAULT 0,
  reply_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  open_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  bounce_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(campaign_id, step, period_start, period_end)
);

CREATE INDEX IF NOT EXISTS idx_step_metrics_campaign_step
  ON campaign_step_metrics(campaign_id, step);
CREATE INDEX IF NOT EXISTS idx_step_metrics_period
  ON campaign_step_metrics(period_start, period_end);

ALTER TABLE campaign_step_metrics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Step metrics viewable by org members" ON campaign_step_metrics;
CREATE POLICY "Step metrics viewable by org members"
  ON campaign_step_metrics FOR SELECT
  USING (
    campaign_id IN (
      SELECT id FROM campaigns
      WHERE organization_id IN (
        SELECT organization_id FROM profiles WHERE id = auth.uid()
      )
    )
  );

-- =============================================================
-- 00045 — source_channel ENUM + columns
-- =============================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'source_channel') THEN
    CREATE TYPE source_channel AS ENUM ('instantly', 'linkedin');
  END IF;
END $$;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS source_channel source_channel NOT NULL DEFAULT 'instantly';
ALTER TABLE lead_replies
  ADD COLUMN IF NOT EXISTS source_channel source_channel NOT NULL DEFAULT 'instantly';
ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS source_channel source_channel NOT NULL DEFAULT 'instantly';

CREATE INDEX IF NOT EXISTS idx_campaigns_source_channel
  ON campaigns (source_channel);
CREATE INDEX IF NOT EXISTS idx_lead_replies_source_channel
  ON lead_replies (source_channel);
CREATE INDEX IF NOT EXISTS idx_webhook_events_source_channel
  ON webhook_events (source_channel);

-- =============================================================
-- 00049 — salesforge columns + ENUM extension
-- =============================================================
ALTER TYPE source_channel ADD VALUE IF NOT EXISTS 'salesforge';

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS salesforge_api_key TEXT,
  ADD COLUMN IF NOT EXISTS salesforge_workspace_id TEXT,
  ADD COLUMN IF NOT EXISTS salesforge_default_product_id TEXT,
  ADD COLUMN IF NOT EXISTS warmforge_api_key TEXT;

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS salesforge_sequence_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_campaigns_org_salesforge_unique
  ON campaigns (organization_id, salesforge_sequence_id)
  WHERE salesforge_sequence_id IS NOT NULL;

ALTER TABLE lead_replies
  ADD COLUMN IF NOT EXISTS salesforge_email_id TEXT,
  ADD COLUMN IF NOT EXISTS salesforge_thread_id TEXT,
  ADD COLUMN IF NOT EXISTS salesforge_mailbox_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lead_replies_salesforge_email_dedupe'
  ) THEN
    ALTER TABLE lead_replies
      ADD CONSTRAINT lead_replies_salesforge_email_dedupe
        UNIQUE (organization_id, salesforge_email_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_lead_replies_salesforge_thread
  ON lead_replies (salesforge_thread_id)
  WHERE salesforge_thread_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lead_replies_salesforge_mailbox
  ON lead_replies (client_id, salesforge_mailbox_id)
  WHERE salesforge_mailbox_id IS NOT NULL;

-- =============================================================
-- 00050 — enrollment queue + per-campaign daily cap
-- =============================================================
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS salesforge_daily_contact_cap INTEGER;

CREATE TABLE IF NOT EXISTS salesforge_enrollment_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sf_queue_campaign_pending
  ON salesforge_enrollment_queue (campaign_id, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sf_queue_campaign_sent_processed
  ON salesforge_enrollment_queue (campaign_id, processed_at)
  WHERE status = 'sent';

CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_queue_pending_dedup
  ON salesforge_enrollment_queue (campaign_id, contact_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_sf_queue_org_status
  ON salesforge_enrollment_queue (organization_id, status, created_at);
```

Re-run the pre-flight check after to confirm everything came back `t`.

> **Note on the new cron:** `00050` enables the `dispatch-salesforge-enrollments` cron (registered in `vercel.json` at `0 12 * * *`, daily at 12:00 UTC — Vercel cron doesn't track DST so this floats by 1h seasonally; in winter it runs at 4am PST, in summer at 5am PDT, always ≤ 5am Pacific). It auto-deploys with the next push to master — no extra activation step. Until a sequence has a cap configured, the cron uses the dispatcher default of 66 new contacts per day; the per-campaign cap can be tuned in the campaign create page or via the inline editor on the campaign detail page.

---

## Step 2 — add API keys

Go to `/app/admin/settings/api`. There are cards for each key we need:

| Card | What you paste | How to get it |
|------|----------------|---------------|
| **Salesforge** | API key, Workspace ID, Default Product ID | [Salesforge dashboard → Settings → API](https://app.salesforge.ai/) — API key auths as `Authorization: <key>` (no Bearer prefix). Workspace + Product cascade-load once the key validates. |
| **Warmforge** | API key | [Warmforge dashboard → Settings → API](https://app.warmforge.ai/) — separate key, mailboxes auto-sync from Salesforge so no extra connect step |
| **Anthropic** | API key | [console.anthropic.com](https://console.anthropic.com/) — used for the reply classifier (`claude-sonnet-…` per [`src/lib/ai/classifier.ts`](src/lib/ai/classifier.ts)) |
| **Perplexity** | API key — optional | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) — only needed for decision-maker enrichment Layer 2; can skip for now |

Each card has a "Test" button — click it after saving to confirm the key works before moving on. Salesforge's test will list workspaces; Anthropic's will fire a tiny prompt and confirm a 200.

Also confirm in Vercel that `WEBHOOK_SECRET` is set — the Salesforge webhook handler uses it to authenticate inbound calls. If the env var is empty in prod, the handler skips the auth check (see [`src/app/api/webhooks/salesforge/route.ts:25`](src/app/api/webhooks/salesforge/route.ts) — `if (expectedSecret && secret !== expectedSecret)`), but Salesforge will still need *some* secret in the registered URL for the webhook to be unique. Generate one with `openssl rand -hex 32` and set it in both `.env.local` and Vercel env vars if it's not already present.

---

## Step 3 — set up the test client + sequence

**Do NOT use a real client for the first run.** The whole point is proving the pipeline works on a sacrificial setup before pointing it at a paying customer.

In `/app/admin/clients`:

1. **Add a test client.** Suggested name: `Smoke Test (Salesforge)`. Fill in:
   - `contact_email`: a mailbox you control
   - `notification_email`: the inbox where you want hot-lead alerts to land (yours)
   - `phone_number`: anything plausible
   - `auto_notify_classes`: leave default — that's the hot classes (`true_interest`, `meeting_booked`, `qualifying_question`, `referral_forward`)
   - `persona_*` fields: fill in something — they're only used for downstream features but the row should be complete so you don't trip over null checks later

2. **Create a Salesforge sequence** in the Salesforge dashboard. Use a mailbox you own (Salesforge requires an existing mailbox before you can create a sequence — see the connect-mailbox link the sidebar surfaces). Add 2–3 seeded contacts (your own email, an alias, a teammate who knows it's a test).

3. **Create the corresponding LeadStart campaign.** The Salesforge Phase 2 dashboard at `/app/admin/campaigns/new/salesforge` should create the LeadStart campaign row + register the webhook for the sequence in one shot. After it runs, verify:

   ```sql
   select id, name, source_channel, salesforge_sequence_id, client_id
   from campaigns
   where source_channel = 'salesforge'
   order by created_at desc
   limit 5;
   ```

   The new test campaign should show up with `source_channel='salesforge'` and `salesforge_sequence_id` populated.

4. **Link the test campaign to the test client.** If the create flow doesn't already do it, set `campaigns.client_id` to the test client's id. Otherwise replies arrive as orphans (they'll classify, but no notification fires).

---

## Step 4 — confirm the webhook is registered

If step 3 worked, the webhook is already registered as part of sequence creation (see [`src/app/api/admin/salesforge/sequences/create/route.ts`](src/app/api/admin/salesforge/sequences/create/route.ts) which calls `registerSequenceWebhooks` from [`src/lib/salesforge/webhooks.ts`](src/lib/salesforge/webhooks.ts)).

To re-register manually (idempotent — Salesforge dedupes by `(sequence_id, event_type, url)`):

```bash
curl -X POST 'https://leadstart-ebon.vercel.app/app/api/admin/salesforge/sequences/<sequence-id>/register-webhooks' \
  -H 'Cookie: <your-session-cookie>'
```

The webhook URL Salesforge gets is `https://leadstart-ebon.vercel.app/app/api/webhooks/salesforge?secret=<WEBHOOK_SECRET>` and it's subscribed to `email_replied`, `positive_reply`, `negative_reply` (see [`src/app/api/webhooks/salesforge/route.ts:15-19`](src/app/api/webhooks/salesforge/route.ts)).

Spot-check via Salesforge's `/v1/webhooks` endpoint or in their dashboard.

---

## Step 5 — smoke test

1. From a seeded test inbox, **reply to the email** Salesforge sent. Keep the body simple — something the classifier will handle predictably, like *"Yes, interested — let's hop on a call"* (should classify as `true_interest`).

2. Within ~30 seconds, watch for:
   - A row in `lead_replies` with `source_channel='salesforge'`, `final_class='true_interest'`, `notification_status='sent'`
   - A hot-lead email in your `notification_email` inbox
   - The reply appearing in `/admin/inbox` filtered to "Hot only"

3. Try the other two classes too:
   - Reply with *"Please remove me"* → expect `final_class='unsubscribe'`, no notification fires (not in `auto_notify_classes`)
   - Reply with *"I'm out of office until Monday"* → expect `final_class='ooo'`, no notification

If any of those is wrong:

| Symptom | Where to look |
|---------|---------------|
| No `lead_replies` row at all | Vercel function logs for `/api/webhooks/salesforge` — auth failure, JSON parse failure, or the org lookup failing |
| Row exists but `final_class` is null after >2 min | Check the `runReplyPipeline` `after()` call — Anthropic key invalid, rate limited, or `webhook_events` shows the event but the pipeline didn't get scheduled |
| Row classified but no notification | `clients.auto_notify_classes` doesn't include the class, or `notification_email` is null on the test client |
| Notification stuck at `pending` | Resend retry cron (`/api/cron/run-notification-retry`) hasn't fired, or Resend key is missing |

---

## Step 6 — point at the real client (only after step 5 is green)

Once the test campaign has classified at least one of each — hot, silent, unsubscribe — and notifications landed correctly:

1. In `/app/admin/clients`, edit the real client row to populate `notification_email` + `phone_number` + `persona_*` (per Path 1 from the original plan — the persona name has to match the real sender on the alias domain).
2. Create the real Salesforge sequence using the real client's mailbox.
3. The webhook auto-registers on sequence creation. No manual click needed.

After the first real reply lands cleanly, **delete this file** in a commit titled `Drop Salesforge activation resume doc — pipeline live for <client>`.

---

## Outstanding fragments (not blockers, but on the radar)

- The classifier prompt + class taxonomy live in [`src/lib/ai/classifier.ts`](src/lib/ai/classifier.ts) and are channel-agnostic. Salesforge replies pass through it directly — no channel-specific tuning needed.
- LinkedIn channel activation (separate initiative) reuses this same `runReplyPipeline` + notification path. Walking through the Salesforge smoke first means LinkedIn activation only needs Unipile-specific wiring later, not pipeline debugging.
- Once Salesforge activation is verified end-to-end on a real client, this doc can be deleted in favor of a short note in `PROJECT_STATUS.md`.
