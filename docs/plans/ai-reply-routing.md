# AI Lead-Reply Classification & Routing — Plan (v2)

> **Status:** Approved, not yet implemented. Ready to start commit #1.
> **Last updated:** 2026-04-20
> **Supersedes:** the v1 plan at this path — v1 assumed the agency owner handled replies with Pushover. v2 puts the client on the phone instead. Git history preserves v1.

---

## Resume Brief (read this first)

### What this is

An automated pipeline that classifies inbound replies to cold-email campaigns and — when a reply is genuinely hot — immediately notifies the **client** (not the agency owner) with the prospect's phone number front and center. The winning move is a phone call within 5 minutes; the portal is a ringing bell and dossier, not a mail client.

The client can optionally send an email reply via the portal as a fallback; that goes out through Instantly's native reply API (no OAuth, no Gmail handoff), with the client's notification email auto-CC'd so the thread lives in their inbox.

### State of the plan

- **Planning complete.** v2 approved after exploring client-direct-response vs agency-bottleneck model.
- **Instantly API capabilities verified** against OpenAPI spec. Reply endpoint, CC field, webhook events confirmed.
- **Probe script** at `scripts/probe-instantly-reply-cc.mjs` — reference only, can be deleted.
- **No code written yet.** Next action is commit #1.

### Key decisions locked in

| Decision | Choice | Why |
|---|---|---|
| **Who responds** | The **client**, not the agency | Speed-to-lead + client's real name in the call beats the agency bottleneck. Unlocks the product moat. |
| **Primary action** | Phone call via `tel:` link | "Call within 5 min" is what wins; email dialogue is secondary. |
| **Email reply (fallback)** | Sent via Instantly `/api/v2/emails/reply` with client CC'd | No OAuth; reuses existing sending infrastructure. |
| **Persona model** | **Path 1 only**: real person on alias domain | Clean continuity when client picks up the phone or takes over the thread. New-client onboarding requirement. |
| **Classification** | Instantly's tag + keyword prefilter + Claude Haiku verifier | Instantly alone has false positives on wrong-contact-with-referral. |
| **No auto-send** | Ever | Holding replies are spam; this is a signal-and-dispatch system, never an auto-reply bot. |
| **Notification channel (v1)** | Single preferred email per client | Client handles their own forwarding rules. Web push + SMS deferred to v2. |
| **Quiet hours** | None | "Be ready by the phone" is the product; accepted at onboarding. |
| **Drafter scope** | Fires on demand when client opens the reply composer, not on every hot reply | Most hot replies get a phone call, not an email. Defer Sonnet cost to when it's actually used. |
| **AI providers** | Claude Haiku (classifier, every hot candidate); Claude Sonnet 4.6 (drafter, on-demand only) | ~$4-7/mo total |

### What the owner will need to provide (when ready to go live)

1. **Anthropic API key**.
2. **URL signing secret** (32+ random chars).
3. **Path 1 migration of the active campaign** — pick the real person on the client's team, swap the persona in Instantly, update signature, confirm written permission to use their name.
4. **Per-client configuration** (onboarding form): named outreach persona, real name + title + LinkedIn photo, notification email, phone number they'll answer on, brand voice paragraph, signature block.
5. **Click "Register webhook"** in admin UI once.

### Onboarding implications — mandatory for every new client

The sales and onboarding process now collects, **before** campaign launch:

- Named outreach persona: a real person on the client's team.
- That person's written permission to use their name on the alias domain.
- Their LinkedIn photo and title for email signatures and the portal dossier.
- **Their phone number**. "Be ready by the phone during your sales hours" is a literal product requirement, communicated to the client in plain English at sign-up.

No client onboards without these. Legacy fake-persona campaigns continue operating on manual reply handling — not routed through this pipeline.

### Security to-dos flagged during planning

- **Rotate the hardcoded Instantly API key** at [scripts/backfill-emails.mjs:9](../../scripts/backfill-emails.mjs) — it's committed to the repo.
- 5 pre-existing webhooks on Instantly (Make.com + LeadConnector) — user confirmed deprecated, safe to coexist.

### Next step when resuming

**Commit #1**: migration `00025_create_reply_pipeline.sql` + types + seed data. Against the real Supabase project (no demo mode per CLAUDE.md). Opens the `/client/inbox` page rendering against empty-or-seeded data. No API keys needed for this commit.

---

## Context

LeadStart's core value is fast human follow-up on hot inbound replies. Every other cold-email agency on the market operates the same way: *agency* runs the campaign, *agency* handles replies, *client* sees a monthly report. Prospect talks to "some guy at the agency" by proxy.

The v2 model inverts this. When a reply is classified as a real buying signal, the client's phone rings in their portal **within seconds**. The conversation moves to a phone call from the actual decision-maker at the client's company. The agency is a signal-routing platform, not a reply bottleneck.

This requires three things working together:
1. **Accurate classification** — Instantly's native tags alone aren't reliable (false positives on wrong-person-with-referral). Belt-and-suspenders with keyword prefilter + Claude verifier.
2. **Persona continuity** — the outreach must already look like it's from the real decision-maker, so the phone pickup feels natural. Path 1 (real person on alias domain) from day one.
3. **Portal as ringing bell** — email notification to the client's preferred address, deep-link to a mobile-friendly dossier with the prospect's phone number and a one-tap `tel:` button.

### Empirical API confirmations (verified against Instantly's OpenAPI + live probes)

- Reply endpoint: `POST /api/v2/emails/reply` — required: `eaccount`, `reply_to_uuid`, `subject`, `body`. Optional: `cc_address_email_list` (comma-separated string).
- Forward endpoint: `POST /api/v2/emails/forward` — same shape, fallback if CC misbehaves.
- Webhook register: `POST /api/v2/webhooks` — subscribe via `event_type: "all_events"`.
- Canonical reply event: `reply_received`.
- **Phone number is in the webhook payload** on the lead record — no extraction heuristics needed.
- Native AI event types: `lead_interested`, `lead_not_interested`, `lead_neutral`, `lead_meeting_booked`, `lead_meeting_completed`, `lead_no_show`, `lead_closed`, `lead_out_of_office`, `lead_wrong_person`, `lead_unsubscribed`.

---

## Architecture at a glance

```
Instantly webhook: reply_received + lead_* tags
  │
  ▼
/api/webhooks/instantly
  │
  ├─ webhook_events insert (audit trail, unchanged)
  ├─ reply_received → ingestReply() — enrich via GET /emails, dedupe, insert lead_replies(status='new')
  └─ lead_* tag → tagReply() — writes instantly_category on the row
  │
  ▼
Classifier pipeline (once both content + tag present)
  │
  ├─ keyword_prefilter.ts — wrong-person markers, embedded emails for referral, unsubscribe phrases
  ├─ claude_classifier.ts (Haiku) — final class + confidence + referral_contact extraction
  └─ decide: hot / silent / needs_human_review
  │
  ▼
If hot (true_interest / referral / qualifying_question / meeting_booked):
  │
  ├─ Email to clients.notification_email via Resend
  │   • Subject: "🔔 {lead_name} @ {company} — {class}"
  │   • Body: reply snippet + prospect phone + deep link
  │   • Deep link: /client/inbox/[id]?token=<hmac>  (4h TTL, single-use session-bump)
  │
  └─ In-app notification row (for desktop portal users already signed in)
  │
  ▼
Client taps notification → /client/inbox/[id]
  │
  ├─ Dossier: lead name, company, title, phone, original reply text
  ├─ Primary CTA: 📞 Call {phone}  (tel: link)
  ├─ Secondary CTA: ✉ Reply via portal  (opens drafter)
  └─ After: outcome capture prompt (called_booked / called_vm / called_no_answer / emailed / no_contact)
  │
  ▼ (if client chose "Reply via portal")
  Drafter (Sonnet) generates initial draft → textarea → edit → Send
  │
  ▼
POST /api/replies/:id/send
  │
  InstantlyClient.replyViaEmailsApi({
    eaccount, reply_to_uuid, subject, body,
    cc_address_email_list: clients.notification_email
  })
  │
  ▼
lead_replies.status = 'sent', sent_at recorded.
Thread continues in client's inbox from here (client CC is on it).
```

---

## Classification taxonomy

`lead_replies.final_class` — derived from Instantly's tag + keyword prefilter + Claude verifier:

| final_class | Source triggers | Bucket | Notify client? | Prompt call? | Draft on demand? |
|---|---|---|---|---|---|
| `true_interest` | Instantly `lead_interested` + Claude confirms | Hot | Yes | Yes, priority | Yes |
| `meeting_booked` | Instantly `lead_meeting_booked` | Hot | Yes | Yes, priority | Yes (confirmation tone) |
| `qualifying_question` | Claude reclassifies from `lead_interested` | Hot | Yes | Yes | Yes |
| `objection_price` | Claude reclassifies | Warm | Yes | Optional | Yes |
| `objection_timing` | Claude reclassifies | Warm | Yes | Optional | Yes |
| `referral_forward` | Keyword prefilter OR Claude detects new contact in body | Referral | Yes | **Depends on prospect's role** — call if decision-influencer, otherwise log new lead | Yes (intro to new contact) |
| `wrong_person_no_referral` | Claude reclassifies `lead_wrong_person` | Silent | No | — | No |
| `ooo` | Instantly `lead_out_of_office` | Silent | No (log return date → reminder) | — | No |
| `not_interested` | Instantly `lead_not_interested` + Claude confirms | Silent | No | — | No |
| `unsubscribe` | Instantly `lead_unsubscribed` | Silent | No (honor) | — | No |
| `needs_review` | Claude confidence < 0.7, or classifier disagrees with Instantly | Review | No (agency owner only) | — | No |

Per-client override: `clients.auto_notify_classes text[]` — default `{true_interest, meeting_booked, qualifying_question, referral_forward}`.

---

## Data model

Single migration: `supabase/migrations/00025_create_reply_pipeline.sql`.

### New enum: `reply_status`

`new` → `classified` → `sent` (if email reply) / `resolved` (if call only) / `rejected` / `expired`

### New table: `lead_replies`

Separate from `lead_feedback` (different writer, different visibility, different cardinality).

**Identity:** `id`, `organization_id` (FK), `client_id`, `campaign_id`, `instantly_email_id`, `instantly_message_id`, `thread_id`, `instantly_campaign_id`.

**Lead/content:** `lead_email`, `lead_name`, `lead_company`, `lead_title`, `lead_phone_e164`, `lead_linkedin_url`, `from_address`, `to_address`, `subject`, `body_text`, `body_html`, `received_at`, `raw_payload jsonb`.

**Classification:**
- `instantly_category text` — raw from Instantly
- `keyword_flags text[]` — wrong-person markers, embedded emails, etc., from prefilter
- `claude_class text` — classifier output (see taxonomy)
- `claude_confidence numeric(3,2)`
- `claude_reason text` — one-line explanation
- `referral_contact jsonb` — `{email, name, title}` when `claude_class = 'referral_forward'`
- `final_class text` NOT NULL — the decision used for routing
- `classified_at timestamptz`

**Notification:**
- `notified_at timestamptz`
- `notification_token_hash text` — HMAC for signed portal deep-link
- `notification_email_id text` — Resend message id

**Outcome (post-contact disposition):**
- `outcome text` — `called_booked` / `called_vm` / `called_no_answer` / `emailed` / `no_contact`
- `outcome_notes text`
- `outcome_logged_at timestamptz`
- `outcome_logged_by uuid`

**Draft (only if client opens composer):**
- `draft_body`, `draft_subject`, `draft_model`, `draft_token_usage jsonb`, `draft_generated_at`, `draft_regenerations int default 0`

**Send (only if client chose email reply):**
- `status reply_status default 'new'`
- `final_body_text`, `final_body_html`, `sent_at`, `sent_instantly_email_id`, `error`

**Indexes:**
- unique `(organization_id, instantly_message_id)` — webhook dedupe
- `(client_id, final_class, received_at DESC)` — client portal inbox
- `(organization_id, final_class, received_at DESC)` — admin oversight
- `(thread_id)` — thread linking
- partial `final_class IN (...hot list...)` for fast unresolved queue
- `(organization_id, status) WHERE status = 'new'`

**RLS:**
- Clients SELECT on `client_id = auth_user_client_id()`, UPDATE only on `outcome_*` and `status`.
- Owners/VAs full SELECT/UPDATE in their org.
- Webhook + drafter + classifier routes use `createAdminClient()` to bypass.

### Column additions

- `clients`:
  - `notification_email text` — single preferred address
  - `phone_number text` — the line they'll answer on (for display only)
  - `auto_notify_classes text[] default '{true_interest, meeting_booked, qualifying_question, referral_forward}'`
  - `persona_name text`, `persona_title text`, `persona_linkedin_url text`, `persona_photo_url text` — Path 1 onboarding fields
  - `brand_voice text`, `signature_block text`
- `organizations`:
  - `instantly_webhook_id text`
- `webhook_events`:
  - add index on `(payload->>'message_id')`

---

## Client portal UX

The primary user surface of this feature.

### Email notification (Resend)

Sent to `clients.notification_email` on every hot reply. Mobile-readable:

- **Subject:** `🔔 {lead_name} @ {company} — {class_label}`
- **Body:**
  - One-line hook: "A hot lead just replied. Call them now."
  - Prospect's full reply (quoted)
  - Phone number in large text with `tel:` link
  - Prospect name, company, title
  - Primary button: "Open in portal" → deep link with signed token

### Client Inbox page — `/client/inbox`

Desktop + mobile. Lists hot replies in reverse-chron. Columns: prospect, company, class badge, received time, outcome badge, phone.

Tapping a row → `/client/inbox/[id]`.

### Reply dossier — `/client/inbox/[id]`

Phone-optimized at mobile widths. Above the fold on any device:

1. **Urgency banner** — "Received X min ago. Every minute matters."
2. **Prospect card** — name, company, title, LinkedIn link, full reply text.
3. **📞 Call now: {phone}** — huge primary button, `tel:` link.
4. **After-call prompt** (revealed after tap or on return to the page): segmented control for outcome + optional notes textarea.
5. **✉ Reply via portal** — secondary button, expands the drafter (Sonnet generates on first click; textarea + "Send" + "Regenerate"). Sent via Instantly reply API with `cc_address_email_list` = `clients.notification_email`.

Signed deep-link from email: HMAC-SHA256, 4h TTL, single-use (bumps them into a session if not already signed in).

---

## Admin oversight — `/admin/inbox`

Not the primary surface anymore. Read-only observer view:

- All replies across all clients in the organization
- Filter by client, class, outcome
- Same classification data visible
- Admin can reclassify `needs_review` items, edit brand voice, flag persona issues
- No send button — sending only happens via client portal

Purpose: quality control, coaching, identifying clients who aren't picking up the phone, training Claude's prompt from misclassifications.

---

## File-by-file change list

### Extend existing
- `src/app/api/webhooks/instantly/route.ts` — branch on `reply_received` → `ingestReply`; `lead_*` → `tagReply`; after both signals present → `runClassifier` + `notifyClient`
- `src/lib/instantly/client.ts` — add `replyViaEmailsApi`, `createWebhook`
- `src/lib/instantly/types.ts` — `InstantlyReplyRequest`, `InstantlyWebhookCreate`, phone field on lead type
- `src/components/layout/sidebar.tsx` — add `Inbox` entry to client-portal nav (new) + admin-nav oversight view
- `.env.example` — add `ANTHROPIC_API_KEY`, `URL_SIGNING_SECRET`

### New files
- `supabase/migrations/00025_create_reply_pipeline.sql` — full migration
- `src/lib/replies/ingest.ts` — enrich via `GET /emails`, normalize, dedupe
- `src/lib/replies/tag.ts` — correlate `lead_*` events
- `src/lib/replies/keyword-prefilter.ts` — wrong-person regexes, email extraction
- `src/lib/replies/classifier.ts` — Claude Haiku structured classification
- `src/lib/replies/decide.ts` — merge Instantly tag + prefilter + Claude into `final_class`
- `src/lib/ai/client.ts` — Anthropic SDK singleton
- `src/lib/ai/prompts/classifier-system.ts` — cached Haiku system prompt
- `src/lib/ai/prompts/drafter-system.ts` — cached Sonnet system prompt
- `src/lib/ai/drafter.ts` — Sonnet, on-demand, `max_tokens: 800`
- `src/lib/notifications/client-email.ts` — Resend template + send
- `src/lib/security/signed-urls.ts` — HMAC-SHA256, 4h TTL, single-use
- `src/app/api/replies/[id]/draft/route.ts` — POST generates draft (lazy)
- `src/app/api/replies/[id]/regenerate/route.ts` — cap 5
- `src/app/api/replies/[id]/send/route.ts` — atomic send through Instantly, CC injected
- `src/app/api/replies/[id]/outcome/route.ts` — record outcome + notes
- `src/app/api/replies/route.ts` — listing for both client and admin
- `src/app/api/cron/expire-replies/route.ts` — mark `new` > 48h as `expired`
- `src/app/api/instantly/register-webhook/route.ts` — one-time bootstrap
- `src/app/(dashboard)/client/inbox/page.tsx` — client list view
- `src/app/(dashboard)/client/inbox/[id]/page.tsx` — dossier + actions
- `src/app/(dashboard)/admin/inbox/page.tsx` — admin observer list
- `src/app/(dashboard)/admin/inbox/[id]/page.tsx` — admin observer detail
- Extend `src/app/(dashboard)/admin/clients/[clientId]/page.tsx` — persona, notification email, phone, brand voice, signature, auto-notify classes
- `scripts/fixtures/webhook-*.json` — synthetic events per class

### Dependencies
- `@anthropic-ai/sdk`

---

## End-to-end flow

1. Webhook arrives → `/api/webhooks/instantly?secret=...` inserts into `webhook_events` (existing), branches on event type.
2. `reply_received` → `ingestReply` enriches via `GET /emails`, inserts `lead_replies(status='new', final_class=null)`. Dedupes on `(org_id, message_id)`.
3. `lead_*` tag → `tagReply` sets `instantly_category`. Creates placeholder row if not yet present.
4. Once both content + tag present → `runClassifier` in `after()`:
   - Keyword prefilter scans body for wrong-person markers and embedded emails.
   - Claude Haiku classifier returns structured output.
   - `decide.ts` merges all three signals into `final_class` + `claude_reason`.
5. If `final_class ∈ clients.auto_notify_classes`:
   - Resend email to `clients.notification_email` with deep-link.
   - In-app notification row.
6. Client taps email / in-app notification → `/client/inbox/[id]?token=...`.
   - HMAC verify → bumps into session if not already logged in.
   - Dossier page renders with phone number and `tel:` button.
7. Client calls. Returns to portal, logs outcome.
8. **OR** client taps "Reply via portal":
   - Drafter fires Sonnet (first open only, cached thereafter).
   - Client edits textarea, hits Send.
   - `POST /api/replies/:id/send` atomic `UPDATE ... WHERE status IN ('new','classified')` → calls Instantly reply API with CC.
   - Returns "Sent ✓", status becomes `sent`.
9. Cron every 6h: `/api/cron/expire-replies` marks `new` > 48h as `expired` (they never got opened).

---

## Env vars

- `ANTHROPIC_API_KEY` — classifier (Haiku) + drafter (Sonnet)
- `URL_SIGNING_SECRET` — HMAC key for portal deep-links (rotate → invalidates outstanding links)
- (Existing, unchanged) `INSTANTLY_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `WEBHOOK_SECRET`, `CRON_SECRET`, Supabase keys

---

## Idempotency, reliability, cost

- **Webhook dedupe** — unique `(org_id, message_id)` makes Instantly retries inert.
- **Send idempotency** — atomic `UPDATE ... WHERE status IN ('new','classified') RETURNING *`; zero rows → "Already handled" page.
- **Classifier idempotency** — only runs when both `body_text` and `instantly_category` are populated and `final_class` is null. Webhook ordering races are handled by the placeholder-row pattern.
- **Regeneration cap** — 5 drafts per reply.
- **Empty-body guard** — skip classification if `GET /emails` returns no body; mark `needs_review`.
- **Timeouts** — Haiku classifier 8s, Sonnet drafter 20s, Instantly send 10s, `GET /emails` 10s, Resend 10s.
- **Cost envelope** (at ~200 hot replies/mo):
  - Haiku classifier: ~$0.10/mo (runs on every candidate, ~400/mo including non-hot)
  - Sonnet drafter (on-demand only, ~20% of hot replies): ~$2/mo
  - Total AI: **$2-3/mo**. Way under v1's estimate because most hot replies never trigger the drafter — client just calls.

---

## Verification plan

### Local dev (against real Supabase)
1. `npm run dev`
2. Apply `00025` migration to local branch of Supabase project.
3. `curl -X POST 'http://localhost:3000/api/webhooks/instantly?secret=dev' -H 'Content-Type: application/json' -d @scripts/fixtures/webhook-lead-interested.json`
4. Within ~1s: `/client/inbox` shows new row, `final_class` correctly `true_interest`.
5. Open `/client/inbox/[id]` → dossier shows phone + prominent `tel:` button.
6. Tap "Reply via portal" → draft generates (Sonnet call logged), textarea populates.
7. Send → log shows Instantly reply API call with CC populated.
8. Log outcome → outcome columns populated.
9. Fire `webhook-lead-wrong-person-with-referral.json` → `final_class = 'referral_forward'`, `referral_contact` populated, no notification to client unless they have `referral_forward` in their `auto_notify_classes`.

### Staging / production with real services
1. API keys configured.
2. Migrate active campaign to Path 1: real persona in Instantly, signature updated.
3. Client onboarded through new form: notification email, phone, persona details.
4. Register webhook via admin UI button.
5. Reply to sandbox campaign: "Sounds interesting, what's the cost?"
6. Within ~15s: client's notification email arrives with phone number + deep link.
7. Tap deep link → dossier renders → tap "Call" → confirm `tel:` opens dialer.
8. Log outcome.
9. Reply "I'm not the right person, please contact Mike at mike@..." → `final_class = 'referral_forward'`, `referral_contact.email = 'mike@...'` extracted.
10. Reply "Not interested" → silent (no notification email), row tagged in admin inbox.

### Regression
- Every non-reply webhook still hits `webhook_events` unchanged.
- Bounce metrics unchanged.
- `/admin/feedback` unaffected.
- Existing manual reply handling for legacy fake-persona campaigns unaffected (those campaigns aren't in the `auto_notify_classes` pipeline since they have no configured `persona_name`).

---

## Risks & mitigations

1. **Client doesn't answer the phone** — The entire product thesis depends on it. Onboarding is explicit: "Be ready by the phone during sales hours." Admin oversight flags clients whose outcome log shows `called_no_answer` repeatedly. Outcome tracking on every reply creates the data to coach clients or drop them from the hot-routing pipeline.

2. **Classification accuracy** — Three-layer defense (Instantly tag + keyword prefilter + Claude verifier). `needs_review` bucket catches low-confidence cases for admin triage. Log every classification and outcome; once we have ~100 labeled pairs we can tune prompts or fine-tune.

3. **Persona mismatch** — If the active campaign still has a fake persona when this ships, the whole flow breaks (prospect sees Sarah emailing but Mike calling). **Mitigation:** v1 hard-requires `persona_name` to be populated for a client to be in the pipeline. Legacy campaigns get no-ops'd with a clear admin warning.

4. **Webhook payload completeness** — real `reply_received` payload fields not precisely documented. Mitigation: enrich via `GET /emails` (pattern established in `scripts/backfill-emails.mjs`).

5. **CC field silent-drop on Instantly side** — documented but unverified empirically. Mitigation: first real send surfaces it. Fallback: `POST /api/v2/emails/forward`.

6. **HMAC token leak** — 4h TTL + single-use enforcement + session bump rather than direct access.

7. **Next.js 16 `after()` API** — verify shape at implementation time. Fallback: queue row + cron worker.

8. **Classification event race** — `reply_received` and `lead_*` can arrive in either order. Placeholder-row pattern handles both.

9. **RLS on unauthenticated routes** — webhook + HMAC approve use `createAdminClient()`. Enforce at code review.

10. **Pre-existing webhooks** — user confirmed Make.com + LeadConnector are deprecated. Safe.

11. **Regulatory / CAN-SPAM** — replies sent via Instantly reply API from the alias domain are still subject to the existing sender's compliance posture (unchanged). No new CAN-SPAM exposure because the portal isn't sending on new senders — it's continuing an existing thread.

---

## The eaccount roundtrip (critical path)

Every reply ingested has a specific hosted mailbox it was sent TO. When the
client later responds through the portal, we MUST send from that same
mailbox (Instantly's reply API requires `eaccount` as a top-level body
field — not inferable from `reply_to_uuid` alone). This thread crosses
multiple commits and is easy to lose track of:

| Commit | Touches eaccount? | What it does |
|---|---|---|
| #1 | migration | creates lead_replies (eaccount column added in #3's follow-up migration 00026) |
| #3 | migration + ingest + send helpers + fixtures + smoke test | adds `eaccount` column, `InstantlyClient.replyViaEmailsApi`, and pure helpers `normalizeReplyFromInstantlyEmail` (writes it in) and `buildReplyRequest` (reads it out). Smoke test at `scripts/test-reply-pipeline.mjs` asserts the roundtrip holds across all fixture scenarios. |
| #6 | webhook handler | calls `InstantlyClient.getEmail(id)` to fetch the full Email object, passes it to `normalizeReplyFromInstantlyEmail` → row lands with `eaccount` populated. |
| #7 | register-webhook route | unchanged path for eaccount; this commit only adds `createWebhook`. |
| #8 | portal send route | reads `lead_replies.eaccount` + `instantly_email_id` from the DB, calls `buildReplyRequest` → `InstantlyClient.replyViaEmailsApi`. CC is injected from `clients.notification_email`. |

Admin oversight page (`/admin/inbox/[id]`) displays `eaccount` alongside
the other classification data — useful for debugging and for admins to
see which mailbox is getting the most hot replies.

---

## Rollout order (single feature branch, multiple commits)

Each commit leaves the app runnable:

**Done:**
1. ✅ **Migration + types + seed data** — `lead_replies`, `clients` additions, 7 seed rows for David Cabrera (commit `0dbbfe8`)
2. ✅ **Client inbox + dossier + admin observer view** — `/client/inbox` + `/admin/inbox` pages, sidebar entries, shared UI helpers (commit `0dbbfe8`)
3. ✅ **Eaccount roundtrip foundation** — migration 00026 + keyword prefilter + ingest/send helpers + `InstantlyClient.replyViaEmailsApi/getEmail` + fixtures + smoke test. All offline; no API keys.

**Remaining:**
4. **Claude Haiku classifier + decide merger** — `@anthropic-ai/sdk`, needs `ANTHROPIC_API_KEY`; decide merges Instantly tag + prefilter + Claude into `final_class`
5. **Resend client-notification email + signed-URL security**
6. **Extend webhook handler** → `getEmail` enrich + ingest (passes `eaccount` through) + tag + classify + notify
7. **Register-webhook bootstrap route** — one-time subscription to Instantly's webhook firehose
8. **On-demand drafter + reply-via-portal send path** — the fallback flow; reads `eaccount` back out and hands it to `replyViaEmailsApi`
9. **Outcome capture API polish + admin reclassify for `needs_review`**
10. **Cron `expire-replies`** — 48h expiry sweeper
11. **Settings pages** — per-client persona + notification email + brand voice + signature + auto-notify classes
12. **Staging smoke test** against real Instantly + real client onboarding Path 1 flow, then merge to master
