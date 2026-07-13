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
Prospect's mail server ── delivers to ──▶ the client's own Google mailbox
                                                         │
                                     every minute        │
                                     cron poll-native-replies polls each mailbox's inbox
                                                         │
                                     thread-match the message back to a native_sends row
                                                         │
                                          ┌──────────────┴──────────────┐
                                          │                             │
                                   (bounce / DSN)                 (human reply)
                                          │                             │
                              suppress the contact          upsert lead_replies row
                              (status='bounced'),           (dedup on gmail_message_id;
                              fail the enrollment            no thread match ⇒ dropped silently)
                                                                        │
                                                                        ▼
                                                  keyword prefilter → Claude Haiku classifier
                                                                        │
                                                                        ▼
                                                  send-hot-lead.ts (throttled Resend)
                                                                        │
                                                         ├─(transient fail)──▶ notification_status='failed'
                                                         │                             ▲
                                                         │                             │ every 2 min
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

### 1. Data integrity (no dropped replies)

**Idempotent reply polling.** The native email channel has no inbound reply
webhook — the sending vendor is our own Gmail integration, not a third party
that can call us. Instead the `poll-native-replies` cron reads each Google
mailbox's inbox every minute. It re-reads an overlapping window on every tick
(a five-minute overlap on the previous watermark) and upserts each message
with a unique constraint on `(organization_id, gmail_message_id)`, so
re-reading the same mail is harmless — a reply can be ingested at most once.
The per-mailbox watermark advances only *after* that mailbox is fully
processed, so a tick that dies mid-run leaves the watermark untouched and the
next tick retries the same window. No reply is dropped or double-counted.
*Implementation:* `src/app/api/cron/poll-native-replies/route.ts`.

**Orphan-reply handling.** A reply is matched to its campaign by Gmail thread
id. If that campaign has no client assigned yet (`client_id IS NULL`), the
reply is still ingested and classified — it simply parks with
`notification_status = 'pending'` and `client_id IS NULL` rather than being
dropped, because we don't yet know which client to notify. Once an admin
assigns the campaign to a client, the queued notification fires. The reply is
never lost while it waits.
*Implementation:* `src/app/api/cron/poll-native-replies/route.ts`,
`src/lib/replies/pipeline.ts` (the `orphan_client` path).

**No enrichment step to fail.** A polled Gmail reply already carries the
sender's address and display name in its own headers, so the lead's identity
comes straight off the message — there is no separate "look up who this is"
call that can time out or exhaust retries. That entire failure mode, which an
external-provider integration would have to guard against, does not exist on
the native channel.
*Implementation:* `src/app/api/cron/poll-native-replies/route.ts`
(`extractEmail` / `extractDisplayName` off the parsed MIME headers).

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
recorded. A cron runs every two minutes, picks up rows with status `failed`
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
The key is currently local state; it persists through rollback paths so a
follow-up commit can add an active pre-check against the timeout-retry window
without another migration. The atomic status claim above is the primary dedup
today.
*Implementation:* `src/lib/replies/send.ts`, `src/app/api/replies/[id]/send/route.ts` (D2).

### 4. Observability & alerting

**401 burst alerting on the delivery webhook.** Every bad-signature hit on
`/api/webhooks/resend` inserts a row into `webhook_auth_failures`. When five
or more failures land for the endpoint in any ten-minute window, and no alert
has fired for it in the last hour, the system emails `OWNER_ALERT_EMAIL` with
first/last failure timestamps, the top source IPs, the top user agents, and
the cooldown-expiry time. Catches a misconfigured-secret deploy within
minutes instead of whenever someone next checks the log.
*Implementation:* `src/lib/notifications/webhook-auth-alerts.ts` (D1).

**Inbox-health monitoring.** The `check-inbox-health` cron scores every native
(Gmail) sending mailbox 0–100 each hour from free deliverability signals —
live SPF/DKIM/DMARC/MX DNS, the Spamhaus domain blocklist, and the 7-day
hard-bounce rate from `native_sends`. It auto-pauses a mailbox that scores
below the org's offline threshold on two consecutive checks (the guard against
a one-off DNS blip benching a healthy inbox) and enqueues an owner alert on
auto-pause or on a fresh transition into the "critical" band. Scores and the
breakdown surface on the **Admin → Mailboxes** page. Answers "is a mailbox
about to start landing in spam?" before the bounce rate does the telling.
*Implementation:* `src/app/api/cron/check-inbox-health/route.ts`,
`src/lib/deliverability/inbox-health.ts`.

**Owner alert delivery + heartbeat.** Alerts raised anywhere in the pipeline
(hard bounces, complaints, auto-paused mailboxes) are enqueued and delivered
by the `dispatch-owner-alerts` cron every five minutes; a daily
`owner-heartbeat` ping confirms the alert path itself is alive even on a quiet
day. So a silent failure surfaces as an email, not as an unread row.
*Implementation:* `src/app/api/cron/dispatch-owner-alerts/route.ts`,
`src/app/api/cron/owner-heartbeat/route.ts`.

**Webhook events retention cron.** Daily at 04:00 UTC, deletes
`webhook_events` rows where `received_at < now() - 90 days AND processed = true`.
Unprocessed rows — the forensically interesting ones — are retained
indefinitely. Keeps the inbound-event audit log fast without losing
diagnostic state.
*Implementation:* `src/app/api/cron/prune-webhook-events/route.ts` (D3).

### 5. Security & access isolation

**Row-level security (RLS).** Every user-facing table has RLS enabled.
Clients see only their own organization's data; admins and VAs are scoped
to their own organization. The service-role key, used by cron jobs and
webhook handlers, bypasses RLS for administrative operations.

**Webhook signature verification.** `/api/webhooks/resend` verifies a
Svix-style HMAC-SHA256 signature against `RESEND_WEBHOOK_SECRET` with a
five-minute replay window to thwart replay attacks. Until that secret is set
in the environment, the endpoint rejects every request with a 401 — the safe
default is to drop events, never to trust unverified webhook input.

**Cron authentication.** Every `/api/cron/*` endpoint — including the reply
poller and the send dispatcher — checks a bearer `CRON_SECRET` before doing
any work, so only Vercel's scheduler (or an operator with the secret) can
trigger the pipeline.

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
| `OWNER_ALERT_EMAIL` | Recipient of 401-burst alert emails |
| `CRON_SECRET` | Bearer token protecting `/api/cron/*` endpoints |
| `ANTHROPIC_API_KEY` | Claude Haiku classifier |
| `URL_SIGNING_SECRET` | Signed URLs for hot-lead dossier deep-links |
| `NEXT_PUBLIC_APP_URL` | Public base URL including any basePath |

**Scheduled jobs (registered in `vercel.json`):**

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/poll-native-replies` | `* * * * *` | Poll Gmail mailboxes for replies + bounces; ingest and classify |
| `/api/cron/run-native-sequences` | `*/15 * * * *` | Send the next campaign step from each mailbox within per-mailbox caps |
| `/api/cron/send-reports` | `0 * * * *` | Send KPI reports per client schedule |
| `/api/cron/expire-replies` | `0 6 * * *` | Age out unresolved hot replies |
| `/api/cron/retry-notifications` | `*/2 * * * *` | Retry failed hot-lead emails |
| `/api/cron/check-inbox-health` | `30 * * * *` | Score mailbox deliverability; auto-pause failing inboxes |
| `/api/cron/dispatch-owner-alerts` | `*/5 * * * *` | Deliver queued owner alerts |
| `/api/cron/prune-webhook-events` | `0 4 * * *` | 90-day retention on `webhook_events` |

**External webhook registrations (one-time per deploy):**

1. **Resend** — register a webhook in the Resend dashboard pointing at
   `<APP_URL>/api/webhooks/resend`, subscribed to the events
   `email.delivered`, `email.bounced`, `email.complained`. Copy the signing
   secret from the Resend webhook-settings page into `RESEND_WEBHOOK_SECRET`.

The email **reply** channel needs no inbound webhook registration — replies
are pulled from each Google mailbox directly by the `poll-native-replies`
cron. There is nothing to register and nothing to switch on; connecting the
mailboxes is enough.

---

## Operational playbook

| Signal | Likely cause | First response |
|---|---|---|
| 401-burst alert email arrives | `RESEND_WEBHOOK_SECRET` mismatch between Vercel env and the Resend webhook registration | Open the Resend webhook settings, compare the signing secret with the Vercel env, re-copy if needed |
| No replies ingested for a long stretch | `poll-native-replies` cron failing, mailboxes in `error` status, or broken Gmail delegation | Check Vercel cron logs for the poller; open **Admin → Mailboxes** and confirm the inboxes are `active` and healthy |
| A campaign's replies aren't reaching a client | The reply landed on a campaign with no client assigned (orphan) | Assign that campaign to a client from **Admin → Campaigns**; the queued notification then fires |
| Failed/retrying notifications > 0 | Resend issue, invalid client notification address, or rate-limit spike | Query `SELECT notification_last_error FROM lead_replies WHERE notification_status='failed'`; cross-check Resend status and the `notification_email` on the affected client |
| `notification_delivered_at` stays NULL after a send | Resend delivery webhook not registered, or `RESEND_WEBHOOK_SECRET` mismatch | Check the Resend webhook delivery log; verify the signing secret in Vercel env matches the one in the Resend dashboard |
| A mailbox was auto-paused | Its health score fell below the org offline threshold on two consecutive checks (blocklist hit, failing SPF/DKIM/DMARC, or a bounce spike) | Open **Admin → Mailboxes**, read the health breakdown, fix the underlying DNS/reputation issue, then resume the mailbox |
| Auth failures 24h > 0 but no alert fired | Below threshold (< 5 in 10 min) or within 1h cooldown from prior alert | Intentional; threshold prevents noise. Investigate only if counts trend upward |
| Reports pages or KPIs stop updating | Analytics not refreshing, or the sending mailboxes have stopped sending | Check the relevant cron logs; confirm mailboxes are `active` and within their send window |

---

## What this gives the end customer (white-label framing)

- **No dropped replies.** Every mailbox is polled on an overlapping window and
  each message is deduplicated before ingest; orphan and notification failures
  are queued, never silently discarded.
- **Delivery transparency.** The system records whether a hot-lead
  notification was actually delivered to the recipient's inbox, not just
  whether Resend accepted the send.
- **Alerts on silent failures.** A misconfigured webhook secret, a burst of
  probing traffic, or a mailbox drifting toward the spam folder generates an
  email to the operator within minutes, with forensic context baked in.
- **At-a-glance health.** The Mailboxes page gives oncall responders a
  per-inbox deliverability score and breakdown without running SQL.
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
| B | Orphan-campaign lifecycle: campaign sync + admin triage UI + lazy webhook creation | `8464d7b`, `2174529`, `f0b1d48` |
| C | Notification reliability: Resend throttle + retry queue, enrichment retry queue, Resend delivery-event ingest | `7676bf0`, `fd0fb83`, `16d838f` |
| D | Observability: 401 alerting, 90-day `webhook_events` retention, idempotency tombstone, pipeline-health dashboard | `3f0468c`, `e94f916`, `43a3dbd`, `fded425` |

The inbound-webhook-specific controls from phases B–D (webhook audit log,
lazy orphan creation on the inbound webhook, enrichment retry queue, the
pipeline-health page) were later superseded when the email channel moved to
the native Gmail poller documented above. See [`SAFETY-TODO.md`](../SAFETY-TODO.md)
for the detailed scope and decision history of each commit.
