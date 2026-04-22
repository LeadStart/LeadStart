# Platform Reliability & Operational Resilience

**IT category:** Operational Resilience / Site Reliability Engineering (SRE).
Overlaps with SOC 2 availability-category controls and ISO 27031 (IT readiness
for business continuity), though the platform is not formally audited against
either today.

**Audience:** operators, integrators, and white-label partners evaluating the
LeadStart reply-routing pipeline before resale. This document catalogs every
production control that protects the business-critical reply path from silent
failures, the specific failure each control guards against, and the
configuration a deployment owner needs to keep it working.

**Scope:** the reply-routing pipeline — from "prospect replies to a cold email"
to "client receives a dossier email and can reply from the portal." This is
the revenue-critical path: a dropped reply is a lost opportunity, so controls
are concentrated here rather than evenly across the app.

---

## Pipeline overview

```
Prospect reply (email)
    │
    ▼
Instantly.ai (cold-email vendor) ─── webhook ───▶ /api/webhooks/instantly
                                                         │
                                                         ├─(bad secret)──▶ webhook_auth_failures ──▶ alert email (≥5/10min)
                                                         │
                                                         ├─(unknown campaign)──▶ lazy-create orphan (client_id NULL)
                                                         │
                                                         ├─(enrichment fails)──▶ park as pending_enrichment
                                                         │                             ▲
                                                         │                             │ every 5 min
                                                         │                             cron retry-enrichment
                                                         ▼
                                                  lead_replies row
                                                         │
                                                         ▼
                                                  Claude Haiku classifier
                                                         │
                                                         ▼
                                                  send-hot-lead.ts (throttled Resend)
                                                         │
                                                         ├─(transient fail)──▶ notification_status='failed'
                                                         │                             ▲
                                                         │                             │ every 10 min
                                                         │                             cron retry-notifications
                                                         ▼
                                                  Client inbox (email handed to Resend)
                                                         │
                                                         ▼
                                                  Resend webhooks (delivered/bounced/complained)
                                                         │
                                                         ▼
                                                  /api/webhooks/resend
                                                         │
                                                         ▼
                                                  lead_replies.notification_delivered_at / _bounced_at
```

---

## Controls by category

### 1. Data integrity (no dropped events)

**Webhook event audit log.** Every POST to `/api/webhooks/instantly` writes the
full payload to `webhook_events` *before* any processing. A downstream bug
cannot cause the original event to be lost; it can always be replayed from the
log. Retention is 90 days for processed rows; unprocessed rows are retained
indefinitely for forensic investigation.
*Implementation:* `src/app/api/webhooks/instantly/route.ts`.
*Retention cron:* `src/app/api/cron/prune-webhook-events/route.ts` (D3).

**Lazy orphan-campaign creation.** If a webhook arrives for a `campaign_id`
LeadStart doesn't yet have in the database — a new Instantly campaign that
hasn't been imported — the handler creates the campaign row on the fly with
`client_id = NULL` rather than dropping the event. The reply still gets a
`lead_replies` row. An admin later assigns the orphan to a client via the
triage UI, which retroactively fires any queued notifications.
*Implementation:* `src/app/api/webhooks/instantly/route.ts`,
`src/app/(dashboard)/admin/campaigns/unlinked/page.tsx` (B2 + B3).

**Enrichment retry queue.** When the webhook's `getEmail` enrichment call to
Instantly exhausts its three-attempt exponential backoff, the handler parks a
minimal `lead_replies` row with `status = 'pending_enrichment'` instead of
dropping the reply. A cron retries every five minutes for up to five attempts
before marking permanently failed. The reply is never lost.
*Implementation:* `src/app/api/cron/retry-enrichment/route.ts` (C2).

### 2. Delivery reliability (notifications land, or we know they didn't)

**Throttled Resend wrapper.** All transactional email sends route through
`src/lib/notifications/resend-client.ts`, which wraps Resend with an in-memory
token bucket (default 2 req/s, env-overridable via `RESEND_RATE_LIMIT_PER_SEC`).
Typed error classes distinguish transient errors (retryable, enqueue for
later) from permanent errors (terminal, stop retrying). Caps bursts from a
single serverless function instance against Resend's rate limits.
*Implementation:* C1.

**Retry queue for failed notifications.** Hot-lead emails that fail
transiently are stamped `notification_status = 'failed'` with the error
recorded. A cron runs every ten minutes, picks up rows with status `failed`
and retry count below five, and retries with exponential backoff via
`notification_last_attempt_at`. Permanent failures are stamped with a
sentinel `retry_count = 99` so the cron skips them.
*Implementation:* `src/app/api/cron/retry-notifications/route.ts` (C1).

**Resend delivery-event ingest.** Resend emits `email.delivered`,
`email.bounced`, and `email.complained` events after handing off an email.
`/api/webhooks/resend` verifies the Svix-style HMAC-SHA256 signature against
`RESEND_WEBHOOK_SECRET` (with a five-minute replay window) and stamps
`notification_delivered_at` or `notification_bounced_at` on the matching
`lead_replies` row. Without this control, a notification that Resend accepted
but the client's mail server silently bounced would appear successful on our
side forever.
*Implementation:* `src/app/api/webhooks/resend/route.ts` (C3).

### 3. Idempotency & deduplication

**Atomic send claim.** When a client clicks Send in the portal,
`/api/replies/[id]/send` runs an atomic
`UPDATE ... WHERE id = :id AND status IN ('new','classified')`. Only one
request wins the row; concurrent or double-clicked sends get HTTP 409. This
is the primary deduplication mechanism and covers the common failure modes.
*Implementation:* `src/app/api/replies/[id]/send/route.ts`.

**Idempotency key tombstone.** Every send also stamps
`lead_replies.idempotency_key = sha256(reply.id + body_text).slice(0, 16)`.
Instantly's v2 API has no documented `Idempotency-Key` header (verified
against their published reference), so the key is currently local state; it
persists through rollback paths so a follow-up commit can add an active
pre-check against the timeout-retry window without another migration.
*Implementation:* `src/lib/replies/send.ts`, `src/app/api/replies/[id]/send/route.ts` (D2).

### 4. Observability & alerting

**401 burst alerting on webhook endpoints.** Every bad-secret hit on
`/api/webhooks/instantly` or bad-signature hit on `/api/webhooks/resend`
inserts a row into `webhook_auth_failures`. When five or more failures land
for a given endpoint in any ten-minute window, and no alert has fired for
that endpoint in the last hour, the system emails `OWNER_ALERT_EMAIL` with
first/last failure timestamps, the top source IPs, the top user agents, and
the cooldown-expiry time. Catches a misconfigured-secret deploy within
minutes instead of whenever someone next checks the log.
*Implementation:* `src/lib/notifications/webhook-auth-alerts.ts` (D1).

**Pipeline health dashboard.** `/admin/pipeline-health` shows a live
snapshot: a pulse indicator (green/amber/red by age of the most recent
webhook event — over one hour amber, over four hours red), events received
in the last 24 hours, replies classified in the last 24 hours, orphan
campaigns awaiting assignment, auth failures in the last 24 hours, a
notifications breakdown (sent / pending / failed+retrying / bounced over
seven days), and stuck-work tiles (pending enrichment, failed
notifications). Answers "is the pipeline alive right now?" in seconds.
*Implementation:* `src/app/(dashboard)/admin/pipeline-health/page.tsx` (D4).

**Webhook events retention cron.** Daily at 04:00 UTC, deletes
`webhook_events` rows where `received_at < now() - 90 days AND processed = true`.
Unprocessed rows — the forensically interesting ones — are retained
indefinitely. Keeps the audit log fast without losing diagnostic state.
*Implementation:* D3.

### 5. Security & access isolation

**Row-level security (RLS).** Every user-facing table has RLS enabled.
Clients see only their own organization's data; admins and VAs are scoped
to their own organization. The service-role key, used by cron jobs and
webhook handlers, bypasses RLS for administrative operations.

**Webhook signature verification.** `/api/webhooks/instantly` verifies a
shared-secret query parameter against `WEBHOOK_SECRET`.
`/api/webhooks/resend` verifies a Svix-style HMAC-SHA256 signature against
`RESEND_WEBHOOK_SECRET` with a five-minute replay window to thwart replay
attacks.

**Service-role separation.** The service-role key
(`SUPABASE_SERVICE_ROLE_KEY`) is used only by server-side routes that need
to bypass RLS. Client-side code uses the anonymous key with RLS enforced.
Keys are distinct environment variables; no route accidentally escalates.

---

## Configuration required for white-label deploys

**Environment variables (set in Vercel Production + Preview):**

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (RLS-enforced) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (RLS-bypass, server-only) |
| `RESEND_API_KEY` | Resend sending account |
| `EMAIL_FROM` | Default `From:` for transactional email |
| `RESEND_WEBHOOK_SECRET` | Svix signing secret from Resend webhook settings |
| `WEBHOOK_SECRET` | Shared secret appended to the Instantly webhook URL |
| `OWNER_ALERT_EMAIL` | Recipient of 401-burst alert emails |
| `CRON_SECRET` | Bearer token protecting `/api/cron/*` endpoints |
| `ANTHROPIC_API_KEY` | Claude Haiku classifier |
| `URL_SIGNING_SECRET` | Signed URLs for hot-lead dossier deep-links |
| `NEXT_PUBLIC_APP_URL` | Public base URL including any basePath |

**Scheduled jobs (registered in `vercel.json`):**

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/sync-analytics` | `0 11 * * *` | Pull campaign analytics from Instantly |
| `/api/cron/send-reports` | `0 15 * * *` | Send weekly KPI reports |
| `/api/cron/expire-replies` | `0 6 * * *` | Age out unresolved hot replies |
| `/api/cron/retry-notifications` | `*/10 * * * *` | Retry failed hot-lead emails |
| `/api/cron/retry-enrichment` | `*/5 * * * *` | Retry stuck `getEmail` enrichments |
| `/api/cron/prune-webhook-events` | `0 4 * * *` | 90-day retention on `webhook_events` |

**External webhook registrations (one-time per deploy):**

1. **Instantly** — register a webhook in the Instantly dashboard pointing at
   `<APP_URL>/api/webhooks/instantly?secret=<WEBHOOK_SECRET>`, with event type
   `all_events`. Can also be done via the admin "Register webhook" button
   (`/admin/settings/api` or similar) which calls
   `POST /api/instantly/register-webhook` server-side.
2. **Resend** — register a webhook in the Resend dashboard pointing at
   `<APP_URL>/api/webhooks/resend`, subscribed to the events
   `email.delivered`, `email.bounced`, `email.complained`. Copy the signing
   secret from the Resend webhook-settings page into `RESEND_WEBHOOK_SECRET`.

---

## Operational playbook

| Signal | Likely cause | First response |
|---|---|---|
| 401-burst alert email arrives | `WEBHOOK_SECRET` mismatch between Vercel env and the Instantly webhook registration | Open the Instantly webhook settings, compare the `?secret=` value with the Vercel env, re-register if needed |
| Pipeline-health pulse is red (> 4h no events) | Instantly webhook broken, or upstream outage | Check Instantly status page; verify webhook registration; inspect `webhook_auth_failures` for recent 401s |
| Pipeline-health pulse is amber (1–4h) | Off-hours lull, normally benign | No action unless it crosses into red |
| Orphan campaigns count > 0 | New Instantly campaign launched and not yet linked to a LeadStart client | Open `/admin/campaigns/unlinked` and assign each to a client; queued notifications fire automatically |
| Pending-enrichment > 0 and not self-clearing | `getEmail` failing past five retries — typically Instantly auth issue or upstream outage | Query `SELECT notification_last_error FROM lead_replies WHERE status='pending_enrichment' ORDER BY enrichment_last_attempt_at DESC`; verify `organizations.instantly_api_key` |
| Failed/retrying notifications > 0 | Resend issue, invalid client notification address, or rate-limit spike | Query `SELECT notification_last_error FROM lead_replies WHERE notification_status='failed'`; cross-check Resend status and the `notification_email` on the affected client |
| `notification_delivered_at` stays NULL after a send | Resend delivery webhook not registered, or `RESEND_WEBHOOK_SECRET` mismatch | Check the Resend webhook delivery log; verify the signing secret in Vercel env matches the one in the Resend dashboard |
| Auth failures 24h > 0 but no alert fired | Below threshold (< 5 in 10 min) or within 1h cooldown from prior alert | Intentional; threshold prevents noise. Investigate only if counts trend upward |
| Reports pages or KPIs stop updating | `sync-analytics` cron failing, or Instantly API key revoked | Check Vercel cron logs; verify the Instantly API key on the org |

---

## What this gives the end customer (white-label framing)

- **No dropped replies.** Every inbound webhook is acknowledged to an audit
  log before processing; enrichment and notification failures are queued,
  never silently discarded.
- **Delivery transparency.** The system records whether a hot-lead
  notification was actually delivered to the recipient's inbox, not just
  whether Resend accepted the send.
- **Alerts on silent failures.** A misconfigured webhook secret or a burst
  of probing traffic generates an email to the operator within ten minutes,
  with forensic context baked in.
- **At-a-glance health.** One dashboard page gives oncall responders a
  yes/no answer on pipeline health without running SQL.
- **Forensic retention.** Processed webhook events are retained 90 days;
  unprocessed events are retained indefinitely for post-incident
  investigation.
- **Safe retries.** Atomic claim + idempotency tombstone means a
  double-clicked Send button cannot produce two emails to a prospect.

---

## Change log

| Phase | Scope | Commits |
|---|---|---|
| A | Schema foundation: nullable `campaigns.client_id`, notification-reliability columns on `lead_replies`, `webhook_auth_failures` log | `83b2f8b` |
| B | Orphan-campaign lifecycle: Instantly sync + admin triage UI + lazy webhook creation | `8464d7b`, `2174529`, `f0b1d48` |
| C | Notification reliability: Resend throttle + retry queue, enrichment retry queue, Resend delivery-event ingest | `7676bf0`, `fd0fb83`, `16d838f` |
| D | Observability: 401 alerting, 90-day `webhook_events` retention, idempotency tombstone, pipeline-health dashboard | `3f0468c`, `e94f916`, `43a3dbd`, `fded425` |

See [`SAFETY-TODO.md`](../SAFETY-TODO.md) for the detailed scope and
decision history of each commit.
