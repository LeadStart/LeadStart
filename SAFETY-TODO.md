# SAFETY-TODO: Reply-chain hardening + campaign onboarding

> **Status (2026-04-22):** All four phases complete and deployed. See [`docs/reliability.md`](docs/reliability.md) for the product-facing summary of every shipped control.
>
> **Goal:** close every silent-failure path between "prospect replies to Instantly" and "client sends a portal reply," and give us a proper onboarding flow for new campaigns.
>
> **Estimated total effort:** ~14h split across 11 commits, 4 phases. All shipped.
>
> **Order matters:** Phase A (schema) unlocks everything downstream. Phases B/C/D can be partially parallelized, but don't skip dependencies.
>
> **After a commit lands:** update its checkbox below and push. Master auto-deploys, so each commit should be complete + verified before the push.
>
> ## Decisions locked in (2026-04-22)
> - **Phase A ships as a single commit** bundling all three migrations. Don't split.
> - **`OWNER_ALERT_EMAIL` = `daniel.tuccillo92@gmail.com`** — used by D1 (webhook 401 alerting) and any future owner-directed alerting. Add to `.env.local` and to Vercel env before D1 ships.
> - **D4 (pipeline health dashboard) is kept** — not safety-critical on its own (the alerts in C1/D1 fire without it), but valuable as an at-a-glance ops view. Owner explicitly opted to keep it.
> - **Resend delivery webhook (C3) is a redundancy check** — Resend returning 200 only means they accepted the send, not that the client's inbox received it. C3 wires their `email.delivered` / `email.bounced` / `email.complained` events to `lead_replies.notification_bounced_at` etc. so silent bounces become visible.
>
> ## Invariants (don't violate without discussion)
> - **One campaign → one client.** Two clients cannot share a campaign. Enforced today by `campaigns.client_id` being a single FK + UNIQUE `(organization_id, instantly_campaign_id)`. Phase B keeps this invariant — orphan campaigns just have `client_id IS NULL` until an owner links them. A client may have many campaigns.
> - **No cross-org links.** Admin UI (B3) must filter the client picker to clients in the same `organization_id` as the campaign.
> - **No local-only schema changes.** Every migration goes to Supabase via `node scripts/supabase-sql.mjs --file <path>`. Supabase project is shared with prod.
> - **Don't push without owner approval** per `memory/feedback_local_only_dev.md`.

---

## Ship log

| Phase | Commit | Summary |
|-------|--------|---------|
| A1    | `83b2f8b` | Schema: orphan campaigns + notification retry queue |
| B1    | `8464d7b` | Cron + admin "Sync from Instantly" button for orphan import |
| B2    | `2174529` | Webhook-time lazy-create of orphan campaigns |
| B3    | `f0b1d48` | Admin triage UI for linking orphan campaigns |
| C1    | `7676bf0` | Resend throttle + retry queue for hot-lead notifications |
| C2    | `fd0fb83` | Enrichment retry queue + pending_enrichment status |
| C3    | `16d838f` | Resend delivery webhook — stamps delivered/bounced on lead_replies |
| D1    | `3f0468c` | 401 burst alerting on both webhook endpoints |
| D3    | `e94f916` | 90-day retention cron for `webhook_events` |
| D2    | `43a3dbd` | Idempotency key tombstone on portal reply sends |
| D4    | `fded425` | `/admin/pipeline-health` dashboard |

Phase D decisions (retained for audit):
- **D1 threshold:** ≥5 failures in 10min triggers an email; 1h no-alert cooldown. Alerts route through the C1 throttled Resend wrapper; skip the retry queue (dropped alerts re-trigger on the next failure).
- **D1 logs only real auth failures** — `bad_secret` on Instantly and `invalid_signature` on Resend. Missing-env 401s (operator config errors) go to console to avoid table-flooding.
- **D2 idempotency key shape:** `sha256(reply.id + body_text).slice(0, 16)`. Instantly has no documented `Idempotency-Key` header, so the key is stored on `lead_replies.idempotency_key` and the atomic status claim handles most dedup today; the column persists through rollback for a future active pre-check.
- **D3 retention:** 90 days, keep unprocessed rows indefinitely. Cron daily at 04:00 UTC.
- **D4 scope:** single read-only admin page at `/admin/pipeline-health`. Pulls every card from state earlier phases populate. Linked into sidebar after Events and wired into `AdminPrefetcher`.

---

## Post-deploy TODO

- [ ] **Smoke-test C3 end-to-end after Instantly webhook activation.** Send a real hot-lead notification through the pipeline (requires Phase D complete + Instantly webhook registered per the activation gate) and confirm `lead_replies.notification_delivered_at` gets populated within ~1 min of Resend delivering the email. If it stays NULL, the URL/secret pairing between Vercel and Resend is off and C3 is silently inert. Not testable before activation because we have no real hot-lead emails flowing yet.

---

## Phase A — Schema foundation

Schema migrations only. Small, mechanical, must land first — every other commit depends on these columns existing.

### [x] A1 — Migrations: nullable client_id, notification status, webhook-auth log

**Scope:** Three forward-compatible migrations.

**Files:**
- `supabase/migrations/00031_make_campaign_client_nullable.sql` — `ALTER TABLE campaigns ALTER COLUMN client_id DROP NOT NULL`. Enables the orphan-campaign queue (campaign exists in our DB but isn't yet linked to a LeadStart client).
- `supabase/migrations/00032_add_notification_reliability.sql` — adds to `lead_replies`:
  - `notification_status TEXT NOT NULL DEFAULT 'pending'` — `pending | sent | failed | retrying`
  - `notification_retry_count INT NOT NULL DEFAULT 0`
  - `notification_last_attempt_at TIMESTAMPTZ`
  - `notification_last_error TEXT`
  - `notification_delivered_at TIMESTAMPTZ` — populated by Resend delivery webhook (C3)
  - `notification_bounced_at TIMESTAMPTZ`
- `supabase/migrations/00033_create_webhook_auth_failures.sql` — new table:
  - `id uuid pk`, `endpoint text`, `reason text` (e.g., `"bad_secret"`), `ip inet`, `user_agent text`, `created_at timestamptz default now()`, index on `(endpoint, created_at desc)`.

**Verification:** `node scripts/supabase-sql.mjs` run each migration; `select column_name from information_schema.columns where table_name in ('campaigns','lead_replies','webhook_auth_failures')` returns the new columns.

**Effort:** ~30min.

---

## Phase B — Campaign sync + linking (onboarding feature)

Solves: new campaigns today require raw SQL. This phase gives us auto-detection + an admin linking UI.

**Invariants to preserve (important):**
- One client can have many campaigns. Two clients can NOT share a campaign — enforced today by `campaigns.client_id` being a single FK + UNIQUE `(organization_id, instantly_campaign_id)`. No change needed.
- A campaign row can exist with `client_id = NULL` (after A1). This is the "orphan / awaiting assignment" state.

### [x] B1 — Cron + on-demand sync inserts orphan campaigns

**Scope:** Extend the existing sync cron to UPSERT campaigns, not just UPDATE. Add an admin button to trigger it on demand.

**Files:**
- Edit [`src/app/api/cron/sync-analytics/route.ts`](src/app/api/cron/sync-analytics/route.ts) — after `getAllCampaigns()`, diff against `dbCampaigns`. For any Instantly campaign not in the DB, INSERT with `client_id = NULL`, `organization_id = org.id`, `status = "active"` (or derived).
- New `src/app/api/admin/sync-campaigns/route.ts` — owner-only POST that invokes the same logic for a specific org (on-demand trigger). Returns `{ created, updated, orphan_count }`.
- Edit `src/app/(dashboard)/admin/campaigns/page.tsx` (if exists) — add "Sync from Instantly" button in the header.

**Verification:**
- Create a new Instantly campaign in the test workspace.
- Click "Sync from Instantly" → new `campaigns` row appears with `client_id = NULL`.
- Existing campaigns' name/status still update without double-inserting.

**Effort:** ~1.5h.

### [x] B2 — Orphan-reply capture for unknown campaigns

**Scope:** Safety net — when a webhook arrives for a `campaign_id` we don't have in DB, create the campaign row on the fly (`client_id = NULL`) rather than dropping the event. The reply still gets a `lead_replies` row so no prospect interaction is lost.

**Files:**
- Edit [`src/app/api/webhooks/instantly/route.ts`](src/app/api/webhooks/instantly/route.ts) — current behavior (`organizationId=null, clientId=null, pipeline skipped`) becomes: look up or create the campaign row, use its org. Insert the `lead_replies` row with `client_id = NULL` (requires `lead_replies.client_id` to be nullable — check if it already is; if not, add migration).
- Edit [`src/lib/replies/pipeline.ts`](src/lib/replies/pipeline.ts) — skip notification send if `client_id IS NULL` but classify + store; set `notification_status = 'pending'` with a reason.

**Verification:**
- Replay a webhook fixture against a `campaign_id` that doesn't exist in the DB.
- Confirm: new `campaigns` row (orphan), `lead_replies` row created, `final_class` populated, `notification_status = 'pending'`, no email sent.

**Effort:** ~1.5h.

### [x] B3 — Admin campaign-link UI

**Scope:** The queue where owners triage orphan campaigns and assign them to clients. Also shows any orphan replies waiting for campaign-link.

**Files:**
- New `src/app/(dashboard)/admin/campaigns/unlinked/page.tsx` — list of orphan campaigns (`client_id IS NULL`). For each: name, Instantly ID, created_at, "pending replies" count, and a "Link to client" button.
- New `src/app/api/campaigns/[id]/link-client/route.ts` — owner-only PATCH `{ client_id }`. Sets `campaigns.client_id`, then UPDATEs all pending `lead_replies` rows for that campaign: set `client_id`, re-run classification if needed (or just enqueue notification if already classified).
- Edit sidebar — add "Unlinked campaigns" under Campaigns, badge with count when > 0.

**UI invariant:** the client picker filters to clients in the same organization as the campaign. No cross-org links.

**Verification:**
- Create an orphan via B1 or B2. Open `/admin/campaigns/unlinked`, pick a client, click Link.
- Confirm: `campaigns.client_id` populated, any queued `lead_replies` rows get `client_id` + kick off the notification path, dashboard badge clears.

**Effort:** ~2h.

---

## Phase C — Notification reliability

Solves: silent notification drops + rate-limit vulnerabilities.

### [x] C1 — Resend throttle + retry queue

**Scope:** Wrap all Resend calls in a token bucket (2 req/s default, overridable by env) + a retry cron that picks up failed notifications.

**Files:**
- New `src/lib/notifications/resend-client.ts` — singleton wrapper around `Resend` with:
  - In-memory token bucket (2 req/s per process). Good enough for single-instance; if we move to multi-region later, upgrade to a Supabase-backed bucket.
  - On success: return normally.
  - On 429/500+: throw a typed `RateLimitedError` / `TransientResendError` so callers can mark `notification_status='failed'` for retry.
- Edit [`src/lib/notifications/send-hot-lead.ts`](src/lib/notifications/send-hot-lead.ts) — use the wrapper; on transient failure, set `notification_status='failed'` + `notification_last_error`.
- Edit [`src/app/api/cron/send-reports/route.ts`](src/app/api/cron/send-reports/route.ts) — same.
- New `src/app/api/cron/retry-notifications/route.ts` — every 10min, scan `lead_replies WHERE notification_status='failed' AND notification_retry_count < 5` and retry. Exponential backoff via `notification_last_attempt_at`.
- Edit `vercel.json` — register the new cron.

**Verification:**
- Unit: stub Resend to return 429 the first 3 calls, success on 4th. Confirm retry cron eventually delivers + `notification_status='sent'`.
- Burst test: invoke `send-hot-lead` 10x in a loop; confirm throttle keeps us at ~2 req/s.

**Effort:** ~2h.

### [x] C2 — Instantly enrichment retry queue

**Scope:** When the webhook's `getEmail` enrichment call exhausts its 3-attempt backoff, instead of aborting, insert a `lead_replies` row with `status='pending_enrichment'` so the reply is at least tracked. A cron retries enrichment.

**Files:**
- Edit [`src/app/api/webhooks/instantly/route.ts`](src/app/api/webhooks/instantly/route.ts) — on `getEmail` failure: insert minimal `lead_replies` with what we have from the webhook body + `status='pending_enrichment'`.
- Edit [`src/types/app.ts`](src/types/app.ts) — add `'pending_enrichment'` to `ReplyStatus`.
- New `src/app/api/cron/retry-enrichment/route.ts` — every 5min, find `lead_replies WHERE status='pending_enrichment' AND retry_count < 5`, retry `getEmail`, on success promote to `status='new'` and kick off pipeline.
- Edit `vercel.json`.

**Verification:**
- Stub Instantly to fail 4 times. Webhook fires → `lead_replies` row exists with `status='pending_enrichment'`. Unstub. Cron runs → row promoted, pipeline runs, notification fires.

**Effort:** ~2h.

### [x] C3 — Resend delivery webhook subscription

**Scope:** Subscribe to Resend's `email.delivered` + `email.bounced` + `email.complained` events. Populate `notification_delivered_at` / `notification_bounced_at` on `lead_replies` so we know when a notification silently bounced (e.g., client's inbox rejected our mail).

**Files:**
- New `src/app/api/webhooks/resend/route.ts` — verify signature (Resend signs with svix-ish headers), match event's `email_id` to `lead_replies.notification_email_id`, update timestamp columns.
- New migration `00034_add_resend_events.sql` only if we want a full audit trail (optional — timestamps on `lead_replies` may be enough).
- Manual setup step (add to SAFETY-TODO checklist): register the webhook in the Resend dashboard.

**Verification:**
- Send a test hot-lead email to a known-bouncing address → Resend fires `email.bounced` → `lead_replies.notification_bounced_at` populated.
- Admin UI surfaces this — see D4.

**Effort:** ~1.5h.

---

## Phase D — Observability / CYA

Solves: invisible failures + operational blindness.

### [x] D1 — 401 alerting on webhook endpoints

**Scope:** Every time Instantly (or anyone) hits `/api/webhooks/instantly` with a bad secret, log to `webhook_auth_failures`. When ≥5 failures in 10 minutes, fire an email alert to the owner so a wrong-secret deploy is caught immediately.

**Files:**
- Edit [`src/app/api/webhooks/instantly/route.ts`](src/app/api/webhooks/instantly/route.ts) — on 401: insert row into `webhook_auth_failures`, then COUNT last 10min, if ≥5 and no alert fired in last hour, fire a Resend email to `process.env.OWNER_ALERT_EMAIL`.
- Re-use the same pattern at `/api/webhooks/resend` (after C3).

**Verification:**
- Hit webhook with wrong secret 5x → email arrives at owner inbox within 1min.

**Effort:** ~45min.

### [x] D2 — Idempotency key on portal reply send

**Scope:** Prevent duplicate sends if our request to Instantly times out after Instantly accepted it. Add a hash-based idempotency key derived from `(reply.id, body_text)`.

**Files:**
- Edit [`src/lib/replies/send.ts`](src/lib/replies/send.ts) — `buildReplyRequest` computes `idempotency_key = sha256(reply.id + body_text).slice(0, 16)`.
- Edit [`src/lib/instantly/client.ts`](src/lib/instantly/client.ts) — `replyViaEmailsApi` passes it as header `Idempotency-Key` if Instantly supports it; otherwise as a body field. **Check Instantly docs first.** If Instantly doesn't support it, we store it in `lead_replies.idempotency_key` and let our own atomic claim ([send/route.ts:152-178](src/app/api/replies/%5Bid%5D/send/route.ts:152)) continue to do the heavy lifting — the current guard already prevents most dupes.

**Verification:**
- Simulate network abort after Instantly accepts: confirm retry produces the same email on Instantly's side, not two.

**Effort:** ~30min (more if Instantly doesn't support it and we do our own).

### [x] D3 — webhook_events retention cron

**Scope:** Keep `webhook_events` from growing indefinitely. Delete rows older than 90 days — except ones we'd want for incident response (failed/unprocessed).

**Files:**
- New `src/app/api/cron/prune-webhook-events/route.ts` — `DELETE FROM webhook_events WHERE created_at < now() - interval '90 days' AND (processed = true OR event_type NOT IN (<the ones we care about forensically>))`.
- Edit `vercel.json`.

**Verification:**
- Seed a row with `created_at = now() - interval '100 days'`, run cron manually, confirm deleted.

**Effort:** ~30min.

### [x] D4 — Pipeline health dashboard

**Scope:** One admin page that answers "is the pipeline healthy right now?" in a glance.

**Files:**
- New `src/app/(dashboard)/admin/pipeline-health/page.tsx` — cards showing:
  - Webhook events received last 24h (total, by type)
  - Replies classified last 24h (with hot/non-hot breakdown)
  - Notifications: sent / failed / pending retry / bounced (pulled from `lead_replies.notification_status`)
  - Orphan campaigns count
  - Pending-enrichment count
  - 401 failures last 24h
  - Last successful webhook event timestamp (red if > 4h old during business hours — "is the pipeline alive?")
- Edit sidebar — add under "Events" / "Inbox Health" section.

**Verification:**
- Page loads for an owner, values match raw DB queries.
- Orphan count changes when B3 links a campaign.

**Effort:** ~2h.

---

## Total effort estimate

| Phase | Commits | Effort |
|-------|---------|--------|
| A — Schema | 1 | 30min |
| B — Campaign sync | 3 | 5h |
| C — Reliability | 3 | 5.5h |
| D — Observability | 4 | 3.75h |
| **Total** | **11** | **~14.75h** |

Phases B + C can run in parallel once A is shipped. D is last — it reads state the earlier commits populate.

## After the bundle lands

- Run the E2E smoke test from the prior diagnostic (seed smoke-test client → register webhook → reply from test prospect → verify dossier + portal reply + outcome logging + expired row).
- Activate David Cabrera's campaign via the admin link UI (no more raw SQL).
- Delete this file + move any remaining residue into `PROJECT_STATUS.md`.
