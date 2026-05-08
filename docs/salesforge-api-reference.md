# Salesforge & Warmforge API reference

Quick-reference notes captured 2026-05-07 while wiring the Salesforge
channel into LeadStart. The full OpenAPI spec is the canonical source
— this file just records the things that aren't obvious from the spec
plus the gotchas we hit during integration.

---

## Salesforge

- **Base URL**: `https://api.salesforge.ai/public/v2`
  The `/public/v2` prefix is part of the base, not a per-endpoint path.
  Hitting `https://api.salesforge.ai/me` directly returns 401 with no
  hint that the path is wrong; the correct call is
  `https://api.salesforge.ai/public/v2/me`.
- **Auth header**: `Authorization: <api-key>` (RAW key — NOT
  `Bearer <key>`).
  Verified live: raw returns 200; Bearer returns
  `{"message":"invalid api key"}` 401. The MCP article's
  `X-Salesforge-Key` header is for a different surface (the MCP
  server) and does not apply here.
- **API key location** (in the Salesforge UI):
  Settings → API & MCP → Add new key. The key is shown once on
  creation and never again — copy it immediately.
- **Trial tier**: includes API access (confirmed 2026-05-07).
- **Swagger UI**: <https://api.salesforge.ai/public/v2/swagger/index.html>
- **OpenAPI JSON**: <https://api.salesforge.ai/public/v2/swagger/doc3.json>
  (note the literal `doc3` — `doc.json` returns 500, `swagger.json`
  and `openapi.json` return 401)
- **List response envelope**: every list endpoint wraps results as
  `{ total, offset, limit, data: T[] }`. The `unwrapList` helper in
  `src/lib/salesforge/client.ts` normalizes this.
- **There are TWO sequence systems** under the same API key:
  - **Legacy** (`/workspaces/{ws}/sequences/...`) — what we use
  - **Multichannel** (`/multichannel/workspaces/{ws}/sequences/...`)
    — newer surface, includes LinkedIn nodes; out of scope for the
    email migration

### Endpoints we currently call

| Method | Path | Purpose | Wired in |
|---|---|---|---|
| GET | `/me` | Validate API key (returns `{accountId, apiKeyName}`) | `SalesforgeClient.getMe`, `/api/admin/salesforge/test` |
| GET | `/workspaces` | List workspaces | `listWorkspaces`, `/api/admin/salesforge/workspaces` |
| GET | `/workspaces/{ws}/products` | List products | `listProducts`, `/api/admin/salesforge/products` |
| GET | `/workspaces/{ws}/sequences` | List sequences | `listSequences` (used by sync) |
| GET | `/workspaces/{ws}/sequences/{seq}` | Get sequence | `getSequence` |
| PUT | `/workspaces/{ws}/sequences/{seq}/status` | Pause/resume/launch | `pauseSequence`/`resumeSequence` *(via SDK helpers — endpoint pending verification)* |
| DELETE | `/workspaces/{ws}/sequences/{seq}` | Delete sequence | `deleteSequence` |
| GET | `/workspaces/{ws}/sequences/{seq}/analytics` | Daily analytics | `getSequenceAnalytics` (sync-analytics cron) |
| GET | `/workspaces/{ws}/mailboxes` | List sending mailboxes | `listMailboxes` (Inbox Health) |
| POST | `/workspaces/{ws}/contacts/bulk` | Bulk-add contacts (cap 100/req) | `addContactsBulk` (push-to-campaign) |
| PUT | `/workspaces/{ws}/sequences/{seq}/contacts` | Enroll contacts in sequence | `addContactsToSequence` |
| POST | `/workspaces/{ws}/mailboxes/{mb}/emails/{em}/reply` | Send reply | `replyToEmail` (`/api/replies/[id]/send`) |
| GET | `/workspaces/{ws}/mailboxes/{mb}/emails/{em}` | Fetch single email | `getEmail` (ingest enrichment, currently unused) |
| GET | `/workspaces/{ws}/integrations/webhooks` | List registered webhooks | *Not yet wired — see "Phase 1"* |
| POST | `/workspaces/{ws}/integrations/webhooks` | Register webhook | *Not yet wired — see "Phase 1"* |

### What Salesforge does NOT expose via API

- **Mailbox connection**: there is no `POST /mailboxes` or
  `PATCH /mailboxes/{id}`. Adding a sending mailbox (Gmail / Outlook
  / IMAP) requires using their dashboard's hosted OAuth flow at
  app.salesforge.ai → Senders & Mailboxes → Connect.
- **Webhook deletion**: there is no `DELETE /webhooks/{id}` in the
  public spec. Webhook registration must be idempotent — list before
  create, dedup by `(sequenceID, eventType, url)`.
- **Step-level analytics**: only sequence-level analytics
  (`/sequences/{seq}/analytics`) is exposed. The Instantly equivalent
  of `/campaigns/analytics/steps` has no Salesforge counterpart, so
  `campaign_step_metrics` rows are not written for
  `source_channel='salesforge'` campaigns.
- **RFC 5322 message-id**: not exposed on email objects. Reply dedup
  uses Salesforge's internal email UUID
  (`(organization_id, salesforge_email_id)` UNIQUE constraint on
  `lead_replies`) instead of the RFC standard message-id we use for
  Instantly.

### Phase 1 (not yet built)

The webhook registration helper is intentionally deferred. Once
built it should:

1. `GET /workspaces/{ws}/integrations/webhooks` to list existing
   subscriptions
2. For each of our ~7 reply event types
   (`email_replied`, `positive_reply`, `negative_reply`,
   `email_bounced`, `contact_unsubscribed`, `dnc_added`,
   `label_changed`), check whether
   `(sequenceID, eventType, our-webhook-url)` already exists
3. If not, `POST /workspaces/{ws}/integrations/webhooks` to register
4. We do not store the resulting webhook IDs locally — the list-on-
   register dedupe is the source of truth

---

## Warmforge

- **Base URL**: `https://api.warmforge.ai/public/v1`
- **Auth header**: `Authorization: <api-key>` (assumed raw — same as
  Salesforge since they're the same vendor; not yet verified end-to-
  end against a real Warmforge call)
- **API key location**: <https://app.warmforge.ai> → Settings → API
- **Bundled with Salesforge**: every Salesforge plan includes
  Warmforge Premium at no extra cost, but the dashboards are
  separate logins. Use the same email as your Salesforge account when
  signing up at app.warmforge.ai.

### Endpoints we currently call

| Method | Path | Purpose | Wired in |
|---|---|---|---|
| GET | `/mailboxes?page=1&page_size=N` | List mailboxes (paginated) | `listMailboxes` (`/api/admin/warmforge/test`) |
| GET | `/mailboxes/{address}` | Per-mailbox heat score, DKIM/SPF/DMARC/MX status, blacklist info, daily warmup stats | `getMailbox` (Inbox Health) |

### Mailbox auto-sync

Mailboxes added to Salesforge automatically appear in Warmforge — no
separate connect step on the Warmforge side. The two products share
the underlying mailbox table.

---

## Schema column mapping (LeadStart ↔ Salesforge)

For reference when reading the migration `supabase/migrations/00049_add_salesforge_columns.sql`:

| LeadStart column | Source field |
|---|---|
| `organizations.salesforge_api_key` | API key from Settings → API & MCP |
| `organizations.salesforge_workspace_id` | Workspace `id` (e.g. `wks_7nex6pbgt8v02dxjqjltz`) |
| `organizations.salesforge_default_product_id` | Product `id` (e.g. `prd_...`) |
| `organizations.warmforge_api_key` | API key from app.warmforge.ai |
| `campaigns.salesforge_sequence_id` | Sequence `id` (e.g. `seq_...`) |
| `lead_replies.salesforge_email_id` | Webhook's email-id field (varies by event; payload not documented in spec) |
| `lead_replies.salesforge_thread_id` | Webhook's thread-id field |
| `lead_replies.salesforge_mailbox_id` | The receiving mailbox `id` |

The webhook payload shape is not documented in the OpenAPI spec.
Field-name extraction in
`src/lib/replies/ingest-salesforge.ts` uses defensive parsing with
fallback names. The first cascade test against a real webhook payload
will confirm or refute the field names; tighten then.
