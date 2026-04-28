# RESUME: LinkedIn Channel via Unipile

> **Status as of last push:** all 9 code commits shipped (latest `64b45fd`). The pipeline is **NOT live** — three migrations + a few env/config steps gate it. See [Activation checklist](#activation-checklist) below.
>
> **What's done:** commits 1–9 (code-complete). ✅ markers on each commit section.
>
> **What's left:** apply migrations, configure Unipile creds, connect a test LinkedIn account, register webhooks in Unipile, smoke test. No more code work in scope for first activation.
>
> **⚠️ Migrations 00045 + 00046 + 00047 must be applied to Supabase project `exedxjrifprqgftyuroc`** via the dashboard SQL editor before the new tables/columns exist. Without them: the connect callback's UPDATE fails, the webhook handler's INSERT into `lead_replies` rejects `source_channel`, and the sequence engine cron 500s.
>
> **⚠️ DELETE THIS FILE once first activation is complete.** Instructions at the bottom.

This document lets a fresh session pick up the LinkedIn channel without re-reading the whole plan. The full architectural context is in [`~/.claude/plans/what-types-of-automations-cuddly-squid.md`](~/.claude/plans/what-types-of-automations-cuddly-squid.md) (the personal plan file the owner kept locally).

---

## Quick-start for each new session

1. `git pull origin master` (per [CLAUDE.md](CLAUDE.md)) and confirm you're at or past `64b45fd`.
2. Open this file, scroll to [Activation checklist](#activation-checklist).
3. Before any code work: `npx tsc --noEmit` should be clean on changed files. Pre-existing errors in `billing/page`, `prospects/page`, `tasks/page`, `inbox-health`, `use-user`, `global-search` are unrelated.

---

## Commits 1–9 — all shipped

### Commit #1 — Migrations 00045 + 00046

> ✅ **SHIPPED in `b4b2a44`** (2026-04-26).

`source_channel` ENUM (`'instantly' | 'linkedin'`) added to `campaigns`, `lead_replies`, `webhook_events` with default `'instantly'`. Unipile columns added to `organizations` (api key + DSN + webhook id), `clients` (`unipile_account_id`, `unipile_account_status`), `campaigns` (`unipile_account_id`), `lead_replies` (`unipile_message_id`, `unipile_chat_id`). `lead_replies.instantly_email_id` + `instantly_message_id` made nullable. AI-opener prep columns on `contacts` (no worker built — just schema).

### Commit #2 — Unipile API client + test endpoint

> ✅ **SHIPPED in `b4b2a44`** (2026-04-26).

`src/lib/unipile/client.ts` mirrors `instantly/client.ts` (3-attempt backoff, X-API-KEY header, DSN-based base URL). Methods: `listAccounts`, `getAccount`, `createHostedAuthLink`, `sendInvitation`, `sendMessage`, `startNewChat`, `listChats`, `getChat`, `getMessage`, `listMessagesInChat`, `createWebhook`, `deleteWebhook`, `testConnection`. Types in `src/lib/unipile/types.ts`. Test endpoint at `POST /api/admin/unipile/test`.

### Commit #3 — Settings UI: Unipile API key card

> ✅ **SHIPPED in `b4b2a44`** (2026-04-26).

`/admin/settings/api` gains a Unipile card with API key + DSN inputs and a Test Connection button. Reads/writes `organizations.unipile_api_key` + `unipile_dsn`.

### Commit #4 — Hosted-auth connect flow + per-client section UI

> ✅ **SHIPPED in `b709faa`** (2026-04-27).

`<LinkedinSection>` collapsible card on `/admin/clients/[clientId]` mirrors `<ReplyRoutingSection>`. Status pill (Disconnected / Connected / Expired). Connect button → `POST /api/admin/clients/[clientId]/linkedin/connect-start` → window.location.href = Unipile hosted-auth URL → Unipile redirects browser to `GET /api/admin/clients/[clientId]/linkedin/connect-callback?account_id=...` → server-side session + org check → write `unipile_account_id` + `unipile_account_status='connected'` → redirect to `/admin/clients/[clientId]?linkedin=connected`. Disconnect via dedicated `POST /api/admin/clients/[clientId]/linkedin/disconnect` (the existing `/api/clients/[id]` PATCH has a strict role-based whitelist that rejects the new columns; cleaner to use a scoped endpoint than to extend the PATCH validation).

### Commit #5 — Unipile webhook handler + reply ingestion

> ✅ **SHIPPED in `141b9fa`** (2026-04-27).

`POST /api/webhooks/unipile`. Optional `?secret=<UNIPILE_WEBHOOK_SECRET>` (separate env from `WEBHOOK_SECRET` so the channels can rotate independently). Resolves client via `clients.unipile_account_id`, audit-logs to `webhook_events` with `source_channel='linkedin'`. Branches:
- `messaging.message_received` → enriches via `getMessage` (skips when `is_sender === true` so our own outbound doesn't masquerade as a reply), upserts into `lead_replies` on `(organization_id, unipile_message_id)`, schedules `runReplyPipeline` via `after()`.
- `account_status.disconnected` / `credentials_invalid` → flips `clients.unipile_account_status='expired'` (which surfaces the Reconnect button in the LinkedinSection UI).
- `account_status.connected` → idempotent backup for the connect-callback path.
- `users.invitation_*` and `messaging.message_read` → audit only; sequence-engine handling lives in the cron worker.

### Commit #6 — Sequence engine schema + builder UI + enroll API

> ✅ **SHIPPED in `dae23e2`** (2026-04-27).

Migration `00047_create_sequence_engine.sql`:
- Makes `campaigns.instantly_campaign_id` nullable (LinkedIn campaigns have no Instantly id); replaces the `UNIQUE(organization_id, instantly_campaign_id)` constraint with a partial unique index that only applies when the column is non-null.
- Adds `campaign_steps` (id, campaign_id, step_index, kind, wait_days, body_template, conditions) with UNIQUE on `(campaign_id, step_index)`.
- Adds `campaign_enrollments` (id, campaign_id, contact_id, current_step_index, last_action_at, status, started_at, unipile_chat_id, unipile_invitation_id, last_error) with UNIQUE on `(campaign_id, contact_id)` and a partial index on `(status, last_action_at) WHERE status='active'` for the cron worker.

UI: `/admin/campaigns/new/linkedin` is a sequence builder. Form: name + client + ordered steps (kind dropdown, wait_days input, body_template textarea, up/down/remove buttons). Defaults to a 4-step starter sequence (connect_request → message after 3d → message after 5d → message after 7d). Saved as `status='draft'` so nothing dispatches until activated. CTA on `/admin/campaigns` next to "Sync from Instantly".

APIs:
- `POST /api/admin/campaigns/linkedin` — owner-only. Inserts campaign + steps atomically; rolls back the campaign if step inserts fail.
- `POST /api/admin/campaigns/[id]/enroll` — owner-only. Bulk-add up to 500 contacts as active enrollments. Idempotent on `(campaign_id, contact_id)`.

### Commit #7 — Sequence engine cron worker

> ✅ **SHIPPED in `e37ea51`** (2026-04-27).

`GET /api/cron/run-linkedin-sequences`. Runs every 15 min (registered in `vercel.json`). Pulls active enrollments whose current step's `wait_days` has elapsed, dispatches via Unipile by step kind, bumps step + `last_action_at` on success or marks the enrollment `failed` with `last_error` on failure.

Supported kinds: `connect_request` (sendInvitation) and `message` (startNewChat for first message in a chat, sendMessage for subsequent). `inmail` / `like_post` / `profile_visit` are reserved — encountering them marks the enrollment failed with a clear "not yet supported" message so the operator sees it in the UI.

Per-account safety caps: 80 connect requests/week and 150 messages/day (LinkedIn enforces ~100 connect/wk hard). Throttled enrollments stay `'active'` and retry next tick. Counter is approximate — counts all dispatches in window without splitting kinds; can split via a dispatch_log table later.

Per-tick cap: 30 enrollments (~45s under Vercel's 60s budget).

Provider ID extraction: `https://linkedin.com/in/<handle>` → `<handle>`. Used as Unipile's `provider_id` for `sendInvitation` / `startNewChat`.

Body template merge: `{{first_name}}`, `{{last_name}}`, `{{company}}`, `{{title}}` from the contact row.

### Commit #8 — Channel-aware admin campaign detail page

> ✅ **SHIPPED in `1b6170c`** (2026-04-27).

When `campaign.source_channel === 'linkedin'`, the admin campaign detail page swaps the email-flavored sections (daily snapshots chart, step funnel, daily breakdown, lead feedback) for LinkedIn-flavored ones in `linkedin-campaign-detail.tsx`:
- KPI cards: active enrollments / replied / completed / failed
- Sequence card: ordered list of steps with kind, wait_days, body_template
- Enrollments table (top 50): contact name + LinkedIn URL, current step, status badge, last action, last error

The email path is untouched. Header for LinkedIn campaigns shows the LinkedIn badge + the bound `unipile_account_id` instead of the (null) `instantly_campaign_id`.

### Commit #9 — Channel-aware client portal campaign view

> ✅ **SHIPPED in `64b45fd`** (2026-04-27).

Client portal mirror of #8 in `linkedin-client-campaign.tsx`. Stripped down — no enrollment table (clients don't need contact-level visibility): LinkedIn badge + status, three KPI cards (in progress / replied / completed), sequence step list, "Detailed daily analytics for LinkedIn campaigns are coming soon" placeholder note. Email path untouched. Branch happens after all hooks have run so rules-of-hooks order is preserved.

---

## What's deferred (not in 1–9)

- **`inmail`, `like_post`, `profile_visit` step kinds.** Builder UI surfaces them; cron worker marks enrollments using these kinds as `failed` with a clear message. Add when there's a real product use case.
- **`/api/cron/sync-linkedin-analytics`.** The plan listed it; deferred because `campaign_snapshots` is email-shaped (emails_sent, replies, bounce_rate) and doesn't fit LinkedIn metrics (connect requests sent, acceptance rate, etc.). Repurposing or adding new schema is a real product decision — defer until the metrics matter for reporting.
- **Synthetic `lead_email` for LinkedIn replies.** `lead_replies.lead_email` is NOT NULL, but LinkedIn DMs don't carry an email. Webhook stores `linkedin:<sender_id>`. Hot-lead notification emails will display this synthetic value until the dossier UI gets channel-aware rendering. Functional, just ugly.
- **Contact resolution from inbound LinkedIn replies.** Currently we don't try to look up `contacts.linkedin_url` to populate `lead_name` / real email. Pipeline still classifies fine (it uses `body_text`).
- **Throttle counter precision.** Counts ALL enrollment dispatches per account per window without splitting connect_request vs message. Conservative for v0; split via a `dispatch_log` table later if it bites.
- **Sales Nav search** (originally part of plan, deferred to post-MVP per the plan's "Future work" section).
- **AI-personalized openers.** Schema is wired (`contacts.intro_line_model`, `intro_line_generated_at`); no Haiku worker built.

---

## Activation checklist

Work through in order. **Do NOT click "Connect LinkedIn" against a real client account on a campaign you care about until step 7 has passed.**

- [ ] **1. Apply migrations 00045 + 00046 + 00047** to Supabase project `exedxjrifprqgftyuroc` via the SQL editor (per project memory: no local Supabase stack). Verify with:
  ```sql
  SELECT column_name FROM information_schema.columns
  WHERE table_name='clients' AND column_name LIKE 'unipile%';
  -- expect: unipile_account_id, unipile_account_status

  SELECT column_name FROM information_schema.columns
  WHERE table_name='lead_replies' AND column_name='source_channel';

  SELECT to_regclass('public.campaign_steps'), to_regclass('public.campaign_enrollments');
  -- both should be non-null
  ```
- [ ] **2. Set `UNIPILE_WEBHOOK_SECRET`** in Vercel env (and `.env.local` for parity). Generate with `openssl rand -hex 32`.
- [ ] **3. Configure Unipile creds.** At `/admin/settings/api`, add the workspace API key + DSN (e.g. `api7.unipile.com:13779`). Click Test Connection — should return success.
- [ ] **4. Connect a TEST LinkedIn account.** Pick a throwaway client (or seed one), click Connect on the LinkedIn channel section, walk through hosted auth with a personal/test LinkedIn account. Confirm `clients.unipile_account_id` populates and the status pill flips to Connected.
- [ ] **5. Register webhooks in the Unipile dashboard.** Two webhooks pointed at `https://leadstart-ebon.vercel.app/app/api/webhooks/unipile?secret=<UNIPILE_WEBHOOK_SECRET>`:
    - source: `messaging`, events: `message_received`
    - source: `account_status`, events: `disconnected`, `credentials_invalid`, `connected`
- [ ] **6. Test inbound reply.** Have a teammate DM the connected test account. Within ~15s confirm:
    - `lead_replies` row created with `source_channel='linkedin'`, `unipile_message_id` populated.
    - Classifier ran (`final_class` populated).
    - If the test client has `notification_email` set + the class is in `auto_notify_classes`, the hot-lead email arrives (synthetic `linkedin:<sender_id>` will show; that's expected until the dossier UI is channel-aware).
- [ ] **7. Test outbound sequence.** Build a small 2-step sequence (1 connect_request → 1 message after 0 wait days) via `/admin/campaigns/new/linkedin`. Manually flip the campaign to `active` (in DB or via existing campaign actions). Enroll a single test contact whose `linkedin_url` you know via the `/api/admin/campaigns/[id]/enroll` endpoint. Wait ≤15 min, confirm:
    - `campaign_enrollments.last_action_at` populated.
    - `unipile_invitation_id` set on the row.
    - LinkedIn shows the invitation pending.
- [ ] **8. Test reconnect.** Manually flip the test client's `unipile_account_status` to `'expired'` in the DB. Open the LinkedinSection — Reconnect button should surface. Click → walk through hosted auth again → status flips back to Connected.
- [ ] **9. If all 8 pass:** delete this file (instructions below) and consider it shipped.

---

## When activation is complete: DELETE THIS FILE

```bash
git rm RESUME-LINKEDIN-CHANNEL.md
git commit -m "Remove LinkedIn channel resume doc — activation complete"
git push origin master
```

Then update [`PROJECT_STATUS.md`](PROJECT_STATUS.md): note LinkedIn channel as live, and start a new section for whatever's next.

---

## Reference

- Main plan: `~/.claude/plans/what-types-of-automations-cuddly-squid.md` (personal, not in repo)
- Unipile docs: [https://developer.unipile.com/](https://developer.unipile.com/)
- Production URL: https://leadstart-ebon.vercel.app
- Last-known-good commit: `64b45fd` (commits 1–9 complete and pushed)
