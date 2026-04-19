# AI Lead-Reply Classification & Routing — Plan

> **Status:** Approved, not yet implemented. Ready to start commit #1.
> **Last updated:** 2026-04-18

---

## Resume Brief (read this first)

### What this is
An automated pipeline that classifies inbound replies to cold-email campaigns, drafts a human-sounding response with Claude, pushes the draft to the owner's phone via Pushover, and — on a one-tap approval — sends the reply through Instantly with the client CC'd.

### State of the plan
- **Planning complete.** The implementation plan (below) is approved.
- **API capabilities verified against Instantly's live OpenAPI spec.** Reply endpoint exists, CC field is natively supported (`cc_address_email_list`, comma-separated string), webhook events confirmed.
- **Probe script exists** at `scripts/probe-instantly-reply-cc.mjs` (uncommitted) — used during planning to confirm endpoints. Can be kept as a reference or deleted.
- **No code written yet.** Next action is commit #1 of the rollout order.

### Key decisions locked in

| Decision | Choice | Why |
|---|---|---|
| Classification source | Instantly's native AI auto-tagging (via `lead_interested` / `lead_out_of_office` / etc. webhook events) | Free, already running, saves ~half the Claude cost vs building our own classifier |
| Send mode | Draft + review + 1-tap send via mobile-optimized page | AI never auto-sends; owner can always edit before sending |
| Mobile channel | Pushover | Reliable push to iOS/Android, supports URL action, $5 one-time |
| CC trigger categories | `lead_interested` + `lead_meeting_booked` only | Per-client override field exists for future expansion |
| AI provider | Claude Sonnet 4.6 (drafting only) | Quality matters most on the draft; caching keeps cost ~$3-5/mo |
| Path for CC | Native `cc_address_email_list` on `POST /api/v2/emails/reply` | Verified in OpenAPI; fallback to `/emails/forward` if it silently drops |

### What the owner will need to provide (when ready to go live)
1. **Pushover setup:** register "LeadStart" as an app at pushover.net → copy the API token. Install Pushover app on phone → copy the user key.
2. **Generate a URL signing secret** (any 32+ random chars).
3. **Click "Register webhook"** in the admin UI once to subscribe our endpoint to Instantly.
4. **Per-client configuration:** CC recipients (names + emails), a paragraph of brand voice, a signature block.

### Security to-dos flagged during planning
- **Rotate the hardcoded Instantly API key** at [scripts/backfill-emails.mjs:9](../../scripts/backfill-emails.mjs) — it's committed to the repo.
- 5 pre-existing webhooks on the Instantly account (Make.com + LeadConnector) — user confirmed these are deprecated. Do not need to delete them; they don't conflict.

### Next step when resuming
**Commit #1 of the rollout order**: migration `00022_create_reply_pipeline.sql` + types + demo mock data. This lets the `/admin/inbox` page render against mock replies locally with zero external services needed. No API keys required. Safe opener.

---

## Context

LeadStart's core value is fast human follow-up on hot inbound replies, with the client CC'd so they see the win land. Today every reply goes to Instantly's unibox and the owner has to manually triage, write a response, and remember to loop the client in — that's slow, error-prone, and doesn't scale past a handful of active clients.

This change adds an automated pipeline: Instantly fires webhook events when replies arrive (including its own AI-generated `lead_interested` / `lead_not_interested` / `lead_out_of_office` / etc. classifications) → for hot categories we draft a reply with Claude → Pushover pushes the draft to the owner's phone → one tap opens a mobile page where the owner reviews, edits, and sends the reply through Instantly with the client on CC. All traffic is visualized in a new admin **Inbox** page.

### Empirical API confirmations (verified against Instantly's OpenAPI + live probes)
- Reply endpoint: `POST /api/v2/emails/reply` — required: `eaccount`, `reply_to_uuid`, `subject`, `body`. Optional: **`cc_address_email_list`** (comma-separated string). **Confirmed via live probe: route returns 400 for empty body.**
- Forward endpoint: `POST /api/v2/emails/forward` — same shape, fallback if CC misbehaves.
- Webhook register: `POST /api/v2/webhooks` — subscribe via `event_type: "all_events"`.
- Canonical reply event: `reply_received` (not `email_replied` as this repo previously used).
- Native AI event types: `lead_interested`, `lead_not_interested`, `lead_neutral`, `lead_meeting_booked`, `lead_meeting_completed`, `lead_no_show`, `lead_closed`, `lead_out_of_office`, `lead_wrong_person`, `lead_unsubscribed`.
- Five pre-existing webhooks on account (Make.com + LeadConnector) — user confirmed deprecated.

---

## Architecture at a glance

```
Instantly
  └─ POST /api/webhooks/instantly  (existing, extended)
       ├─ webhook_events insert (unchanged)
       ├─ if reply_received → ingestReply() (enriches via GET /emails)
       └─ if lead_* event → tagReply() (sets category on matching row)
                                                  │
                              category hot? ──────┘
                                    │
                                    ▼
                          drafter.ts (Sonnet 4.6)
                                    │
                          lead_replies row updated
                                    │
                             pushover.ts → phone
                                    │
                    owner taps → /admin/inbox/[id]/quick?token=<hmac>
                                    │
                            [ review / edit / send ]
                                    │
                        POST /api/replies/:id/approve
                                    │
                  InstantlyClient.replyViaEmailsApi({
                    eaccount, reply_to_uuid, subject, body,
                    cc_address_email_list: "client@x.com,client2@x.com"
                  })
```

---

## Classification → Inbox bucket mapping

We use Instantly's event names directly; no new enum required.

| Instantly event | Bucket | Badge | Draft? | CC client? | Notify? |
|---|---|---|---|---|---|
| `lead_interested` | Interested | green | Yes | Yes | High priority |
| `lead_meeting_booked` | Meeting booked | green | Yes (confirmation) | Yes | High priority |
| `lead_neutral` | Neutral | amber | No (v1) | No | Normal |
| `lead_out_of_office` | OOO | slate | No | No | Silent |
| `lead_wrong_person` | Wrong person | slate | No | No | Silent |
| `lead_not_interested` | Not interested | red | No | No | Silent |
| `lead_unsubscribed` | Unsubscribed | red | No | No | Silent |
| `lead_meeting_completed` | Meeting done | green | No | No | Silent (log) |
| `lead_closed` | Closed | slate | No | No | Silent |
| `reply_received` (no tag yet) | Unclassified | slate | No | No | Silent (until lead_* event catches up) |

Per-client override lives on `clients.auto_forward_categories` — default `{lead_interested, lead_meeting_booked}`.

---

## Data model (single migration: `supabase/migrations/00022_create_reply_pipeline.sql`)

### New enum: `reply_status`
`pending, approved, sending, sent, rejected, saved_later, expired, failed`

### New table: `lead_replies`

Separate from `lead_feedback` (different cardinality, different writer, different visibility).

- **Identity:** `id`, `organization_id` (FK), `client_id`, `campaign_id`, `instantly_email_id`, `instantly_message_id`, `thread_id`, `instantly_campaign_id`.
- **Lead/content:** `lead_email`, `lead_name`, `lead_company`, `from_address`, `to_address`, `subject`, `body_text`, `body_html`, `received_at`, `raw_payload jsonb`.
- **Category:** `category text` (Instantly event name), `instantly_interest_status integer`, `categorized_at timestamptz`.
- **Draft:** `draft_subject`, `draft_body`, `draft_model`, `draft_token_usage jsonb`, `draft_generated_at`, `draft_regenerations integer default 0`.
- **Approval/send:** `status reply_status default 'pending'`, `pushover_sent_at`, `pushover_receipt`, `approval_token_hash`, `approved_at`, `approved_by`, `body_edited boolean`, `final_body_text`, `final_body_html`, `cc_addresses text[]`, `sent_at`, `sent_instantly_email_id`, `rejected_at`, `rejected_reason`, `error`.

**Indexes:** unique `(organization_id, instantly_message_id)` for dedupe; `(organization_id, status, received_at DESC)`; `(organization_id, category, received_at DESC)`; `(thread_id)`; partial `status='pending'`.

**RLS:** owners/VAs SELECT/UPDATE in their own org. Webhook + approve routes use `createAdminClient()` to bypass.

### Column additions
- `clients`: `notification_emails jsonb default '[]'` (array of `{name,email}`), `auto_forward_categories text[] default '{lead_interested,lead_meeting_booked}'`, `brand_voice text`, `signature_block text`.
- `organizations`: `instantly_webhook_id text`, `pushover_app_token text` (nullable).
- `webhook_events`: add index on `(payload->>'message_id')`.

### New table: `user_notification_prefs`
Per-user. Columns: `user_id PK`, `organization_id`, `pushover_user_key text`, `channels_enabled jsonb` default `{"pushover":true,"categories":["lead_interested","lead_meeting_booked"]}`. RLS: user rw own row only.

---

## Mobile approval UX

Main user-facing surface of the feature.

### Push notification (Pushover)
- **Title:** `{emoji} {Category} — {Lead name} @ {Company}`
- **Message** (HTML, ~800 chars): prospect's reply snippet + `Draft:` + first chunk of Sonnet's draft
- **URL:** `https://leadstart-ebon.vercel.app/app/admin/inbox/{id}/quick?token={hmac}`
- **URL title:** `Review & Send`
- **Priority:** 1 for hot; 0 for normal; −1 for silent
- **Sound:** `pushover` for normal; `magic` for hot

Pushover supports one URL per notification. The tap opens a mobile page for edit capability.

### Mobile review page (`/admin/inbox/[id]/quick`)

Server-rendered, phone-optimized (max-width 640px, large tap targets, no sidebar chrome):
1. **Thread header** — lead name, company, campaign, time since received
2. **Their message card** — full text, read-only
3. **Draft textarea** — editable, prefilled, auto-grows
4. **Regenerate button** — tiny prompt → re-draft → new text in textarea (cap 5 regens)
5. **CC recipients** — editable list
6. **Primary: `[ Send reply ]`**
7. **Secondary: `[ Reject ]` `[ Save for later ]`**

After Send: ephemeral "Sent ✓" page. Single-use HMAC token is invalidated.

### Auth model
- **From push link:** HMAC-signed URL (4h TTL, single-use). No login needed.
- **From desktop Inbox:** Supabase session auth.

---

## File-by-file change list

### Extend existing
- `src/app/api/webhooks/instantly/route.ts` — branch on `reply_received` → `ingestReply` + `after(runReplyPipeline)`; `lead_*` → `tagReply`
- `src/lib/instantly/client.ts` — add `replyViaEmailsApi`, `forwardViaEmailsApi`, `createWebhook`
- `src/lib/instantly/types.ts` — add `InstantlyReplyRequest`, `InstantlyForwardRequest`, `InstantlyWebhookCreate`
- `src/components/layout/sidebar.tsx` — add `Inbox` entry above Inbox Health; change Inbox Health icon
- `src/lib/supabase/demo-client.ts` — register new tables in `TABLES`
- `src/lib/mock-data.ts` — `MOCK_LEAD_REPLIES` (~12 rows), extended `MOCK_CLIENTS`
- `.env.example` — add `ANTHROPIC_API_KEY`, `PUSHOVER_APP_TOKEN`, `URL_SIGNING_SECRET`

### New files
- `supabase/migrations/00022_create_reply_pipeline.sql` — full migration
- `src/lib/replies/ingest.ts` — enrich via `GET /emails`, normalize, dedupe
- `src/lib/replies/tag.ts` — correlate `lead_*` events to rows
- `src/lib/replies/pipeline.ts` — orchestrate draft + notify when both signals present
- `src/lib/ai/client.ts` — Anthropic SDK singleton
- `src/lib/ai/prompts/drafter-system.ts` — cached system prompt
- `src/lib/ai/drafter.ts` — Sonnet 4.6, `max_tokens: 800`
- `src/lib/ai/demo-responses.ts` — deterministic demo drafts
- `src/lib/notifications/pushover.ts` — POST to `api.pushover.net`
- `src/lib/notifications/in-app.ts` — writes to existing `notifications` table
- `src/lib/security/signed-urls.ts` — HMAC-SHA256, 4h TTL
- `src/app/api/replies/[id]/approve/route.ts` — atomic send w/ CC
- `src/app/api/replies/[id]/reject/route.ts`
- `src/app/api/replies/[id]/save-later/route.ts`
- `src/app/api/replies/[id]/regenerate/route.ts`
- `src/app/api/replies/route.ts` — listing
- `src/app/api/cron/digest-replies/route.ts` — 4h digest
- `src/app/api/instantly/register-webhook/route.ts` — one-time bootstrap
- `src/app/(dashboard)/admin/inbox/page.tsx` — desktop Inbox
- `src/app/(dashboard)/admin/inbox/[id]/page.tsx` — desktop detail
- `src/app/(dashboard)/admin/inbox/[id]/quick/page.tsx` — mobile quick-approve
- `src/app/(dashboard)/admin/settings/notifications/page.tsx` — Pushover key + test
- Extend `src/app/(dashboard)/admin/clients/[clientId]/page.tsx` — notification recipients + brand voice
- `scripts/fixtures/webhook-*.json` — synthetic events per category

### Dependencies
- `@anthropic-ai/sdk`

---

## End-to-end flow

1. Webhook arrives → `/api/webhooks/instantly?secret=...` inserts into `webhook_events` (existing), branches on event type.
2. `reply_received` → `ingestReply` enriches via `GET /emails`, inserts `lead_replies(status='pending', category=null)`. Dedupe on `(org_id, message_id)`.
3. `lead_*` event → `tagReply` sets `category` on matching row. Creates placeholder if row not yet present.
4. When both content + category present AND `category ∈ auto_forward_categories`: `runReplyPipeline` calls Sonnet for draft.
5. Notify via Pushover with HMAC-signed URL (4h TTL).
6. Owner taps push → `/admin/inbox/[id]/quick?token=...`. HMAC verify → mobile review page.
7. Owner edits + hits Send → POST `/api/replies/[id]/approve` with override `{body_text, body_html, cc_addresses}`. Atomic `UPDATE ... WHERE status='pending'`. Calls `replyViaEmailsApi` with CC. Marks `status='sent'`. Returns "Sent ✓".
8. Desktop Inbox at `/admin/inbox` mirrors queue; session auth instead of HMAC.
9. Cron every 4h: `/api/cron/digest-replies` emails a digest of `pending > 4h`, marks them `expired`.

---

## Env vars (to add to `.env.example`)

- `ANTHROPIC_API_KEY` — Claude Sonnet for drafting
- `PUSHOVER_APP_TOKEN` — LeadStart's Pushover app token
- `URL_SIGNING_SECRET` — HMAC key (rotate → invalidates outstanding links)
- (Existing, unchanged) `INSTANTLY_API_KEY`, `RESEND_API_KEY`, `EMAIL_FROM`, `WEBHOOK_SECRET`, `CRON_SECRET`, Supabase keys

---

## Demo mode parity

Everything must no-op cleanly under `DEMO_MODE=true`:
- Anthropic → `demo-responses.ts` template drafts
- Pushover → log payload, return mock receipt
- Instantly reply → skip API, set `sent_at`, toast "Demo mode"
- Register webhook → no-op
- Mock data populates Inbox on first load

---

## Idempotency, reliability, cost

- **Webhook dedupe** — unique `(org_id, message_id)` makes Instantly retries inert
- **Approve idempotency** — atomic `UPDATE ... WHERE status='pending' RETURNING *`; zero rows → "Already handled" page
- **Race handling** — `lead_*` before/after `reply_received`; placeholder-row creation either way
- **Regeneration cap** — 5 per reply
- **Empty-body guard** — skip drafting if `GET /emails` returns no body
- **Timeouts** — drafter 20s, Pushover 10s, Instantly 10s, GET-emails 10s
- **Cost envelope** — Sonnet only, ~200 drafts/mo, cached prompts → **$3-5/month**

---

## Verification plan

**Local demo mode:**
1. `DEMO_MODE=true npm run dev`
2. `curl -X POST 'http://localhost:3000/api/webhooks/instantly?secret=dev' -H 'Content-Type: application/json' -d @scripts/fixtures/webhook-lead-interested.json`
3. `/admin/inbox` shows row in correct category with draft
4. `/admin/inbox/[id]/quick` at phone width — edit draft, Send → demo toast
5. `/admin/settings/notifications` → "Send test" → console logs

**Staging with real services:**
1. Real keys configured, Pushover installed on phone
2. Register webhook via admin UI button
3. Reply to sandbox campaign: "Sounds interesting, what's the cost?"
4. Within ~15s: phone buzzes
5. Tap push → mobile page → edit word → Send
6. Verify prospect received reply AND test CC received copy AND Gmail threads it
7. Reply "Not interested" → confirm silent, row in Inbox as `lead_not_interested`

**Regression:** every non-reply webhook still hits `webhook_events` unchanged; bounce metrics unchanged; `/admin/feedback` unaffected.

---

## Risks & mitigations

1. **Webhook payload completeness** — real `reply_received` payload fields not precisely documented. Mitigation: enrich via `GET /emails` (pattern already established in `scripts/backfill-emails.mjs`).
2. **CC field silent-drop** — documented but unverified empirically. Mitigation: first real reply surfaces it. Fallback: `POST /api/v2/emails/forward` right after reply.
3. **HMAC token leak** — 4h TTL + single-use enforcement.
4. **Next.js 16 `after()` API** — verify shape at implementation time. Fallback: internal fetch.
5. **Classification event race** — placeholder rows + 15-min correlation window.
6. **RLS on unauthenticated routes** — explicit `createAdminClient()` in webhook + HMAC approve. Enforce at code review.
7. **Pre-existing webhooks** — user confirmed Make.com + LeadConnector are deprecated; safe to coexist.
8. **Pushover rate limits** — 10k/mo free; at ~200 hot leads/mo we're 2%.
9. **Demo-mode bleed** — every external call needs `isDemoMode()` guard.

---

## Rollout order (single feature branch, multiple commits)

Each commit leaves the app runnable:

1. **Migration + types + demo mock data** — Inbox visible against mock data
2. **Admin Inbox desktop pages** — read-only against mock
3. **Mobile quick-approve page** — stubbed approve/reject calls
4. **`@anthropic-ai/sdk` + drafter** — demo stubs
5. **Pushover client + signed URLs + real approve/reject/regenerate/save-later routes**
6. **Extend webhook handler → ingest + tag + pipeline**
7. **Instantly client additions (`replyViaEmailsApi`, `forwardViaEmailsApi`, `createWebhook`) + register-webhook bootstrap**
8. **Settings pages** — notifications + per-client editor
9. **Cron digest-replies + digest email template**
10. **Staging smoke test against real Instantly, then push to master**
