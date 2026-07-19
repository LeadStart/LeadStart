# Resume doc — Instantly.ai email channel (re-added)

> Status: **code-complete, NOT live yet.** Gated on: apply migration `00065`,
> add the Instantly API key in Settings, deploy, register the reply webhook,
> then sync + link a campaign. No further code required for first activation.

## What this is

Instantly was the platform's original email channel; it was fully removed in
2026-05 (migration `00051` dropped the schema, commit `5cc1589` deleted the
code) when the platform moved to Salesforge and then to the native Gmail API.
This re-adds Instantly as a **parallel channel alongside native Gmail** (native
Gmail stays live and untouched) using the **link-existing model**:

- Campaigns are **authored + sent inside Instantly** (its own inboxes, warmup,
  sequencing).
- LeadStart **links** to those campaigns, **pushes leads** into them, **ingests
  replies** into the shared classify + hot-lead-notify pipeline, rolls up
  **analytics**, drives **pause/resume/activate** upstream, surfaces **inbox
  warmup health**, and can **send replies back** through Instantly.

`source_channel = 'instantly'` is the row-level discriminator, exactly like
`'native_email'` and `'linkedin'`.

## The five surfaces (all built)

| Surface | Where |
|---|---|
| API key + validation + webhook registration | `/admin/settings/api` Instantly card → `/api/admin/instantly/test`, `/api/admin/instantly/register-webhook` |
| Reply ingestion | `/api/webhooks/instantly` → `runReplyPipeline` (shared classify + notify) |
| Campaigns: link/sync + lead upload + lifecycle | "Sync Instantly" button on `/admin/campaigns` → `/api/admin/instantly/sync-campaigns`; "Add to Campaign" (contacts) uploads via `/api/admin/contacts/push-to-campaign`; pause/resume/activate call Instantly's API |
| Analytics | `/api/cron/sync-analytics` Instantly leg → `campaign_snapshots` (dashboards already read these) |
| Inbox / warmup health | "Check inbox health" in the Instantly settings card → `/api/admin/instantly/inbox-health` |
| Outbound replies (portal) | `/api/replies/[id]/send` Instantly branch → Instantly `/emails/reply` |

## Files

**Added**
- `supabase/migrations/00065_add_instantly_channel.sql`
- `src/lib/instantly/client.ts`, `types.ts` (restored from git `5cc1589^`)
- `src/lib/instantly/auth.ts` (org-key gate), `campaign-lifecycle.ts` (pause/activate helper)
- `src/app/api/admin/instantly/{test,register-webhook,sync-campaigns,inbox-health}/route.ts`
- `src/app/api/webhooks/instantly/route.ts`

**Changed**
- `src/types/app.ts` — `SourceChannel` += `instantly`; `instantly_*` fields on Organization / Campaign / LeadReply
- `src/lib/notifications/webhook-auth-alerts.ts` — endpoint union += `/api/webhooks/instantly`
- `src/app/(dashboard)/admin/settings/api/page.tsx` — Instantly card + inbox-health panel
- `src/app/(dashboard)/admin/campaigns/page.tsx` — "Sync Instantly" button
- `src/app/(dashboard)/admin/campaigns/campaign-row-actions.tsx` — Activate enabled for Instantly
- `src/app/api/admin/campaigns/[id]/{pause,resume,activate}/route.ts` — Instantly branch (drives Instantly upstream)
- `src/app/api/admin/campaigns/[id]/link-client/route.ts` — ported the orphan→client notification catch-up (was only in the unused PATCH route)
- `src/app/api/admin/contacts/push-to-campaign/route.ts` — Instantly upload leg
- `src/app/api/cron/sync-analytics/route.ts` — Instantly analytics leg
- `src/app/api/replies/[id]/send/route.ts` — Instantly outbound branch

## Environment variables

| Var | Required? | Purpose |
|---|---|---|
| `INSTANTLY_API_KEY` | optional | Local-dev fallback only. In prod the key is stored per-org via Settings; this env var is a fallback if the column is empty. |
| `INSTANTLY_WEBHOOK_SECRET` | optional but recommended | If set, `/api/webhooks/instantly` requires `?secret=…`. `register-webhook` appends it automatically. Per-channel secret, mirrors `UNIPILE_WEBHOOK_SECRET`. |
| `NEXT_PUBLIC_APP_URL` | already set | Used to build the webhook receiver URL. Must be the public prod URL (includes `/app`). |

## Activation checklist

1. **Apply migration `00065`** via the Supabase dashboard SQL editor (project `exedxjrifprqgftyuroc`). It only *adds* columns + the `'instantly'` enum value — additive and safe. (Reversing native Gmail is not involved.)
2. **Deploy** — push to `master` (auto-deploys). The webhook receiver must be publicly reachable; Instantly can't reach localhost.
3. **(Recommended)** Set `INSTANTLY_WEBHOOK_SECRET` in Vercel env before registering the webhook.
4. **Add the Instantly API key** in `/admin/settings/api` → Instantly card → Save → **Test Connection**. The key needs campaigns, leads, emails, and webhooks scopes.
5. **Register the reply webhook** — same card → "Register webhook". Stores `organizations.instantly_webhook_id`. Idempotent.
6. **Sync campaigns** — `/admin/campaigns` → "Sync Instantly". New campaigns appear as **Unlinked**.
7. **Link each campaign to a client** — open the campaign → "Link to a client". (This also fires alerts for any replies already ingested while it was unlinked.)
8. **Push leads** — Contacts page → select → "Add to Campaign" → pick the Instantly campaign. Contacts upload into Instantly.
9. **Smoke-test:**
   - Reply to a test send → confirm a row lands in the admin inbox, classified, and (if hot) an alert fires.
   - From the inbox composer, send a reply on a hot Instantly lead → confirm it goes out via Instantly and `sent_external_email_id` is stamped.
   - Pause the campaign from LeadStart → confirm it pauses in Instantly.
   - `/admin/settings/api` → "Check inbox health" → confirm accounts + warmup scores render.

## Decisions / behaviors baked in

- **Dedup on `instantly_email_id`** (Instantly's Email UUID — always present on the reply webhook, unlike the RFC message-id which only arrives after enrichment). Regular UNIQUE constraint (not a partial index) so the webhook upsert's `onConflict` matches it.
- **Enrichment failure ≠ dropped reply.** If Instantly's `/emails/{id}` enrichment fails (after the client's 3× backoff), the reply row is still inserted (visible in the inbox), just left unclassified. No `pending_enrichment` zombie status, no retry cron — deliberately simpler than the old handler.
- **Delete = unlink locally**, it does NOT delete the Instantly campaign. To actually stop an Instantly campaign, Pause it (that calls Instantly's API). Note: because delete is local-only, a still-running Instantly campaign's next reply will lazy-recreate the orphan row.
- **Unsubscribe replies flip the global contact suppression** (native deliberately doesn't; Instantly/LinkedIn do). An unsub is an unsub.
- **Orphan campaigns** (from lazy-create-on-reply or sync-before-link) classify replies but skip notification until linked; the admin link route now fires the deferred notifications on link (catch-up ported from the previously-unused PATCH route).
- **Analytics split:** send-side volume (sent/bounces/new-leads) comes from Instantly's daily-analytics API; reply/classification metrics (replies/positive/unsub/meetings) come from our own `lead_replies`, so hot-lead numbers reflect our classifier.
- **No new cron.** The webhook is inbound; the hourly `sync-analytics` cron gained the Instantly leg. `vercel.json` unchanged.
