# LeadStart — Project Status

> Last updated: 2026-07-19

## Current State: Deployed to Production, native-Gmail-only

Live at https://leadstart-ebon.vercel.app (LeadStart Vercel account, auto-deploys on push to `master`). Real Supabase project (`exedxjrifprqgftyuroc`). Real auth, real data. No mock-mode anywhere — local dev points at the same Supabase.

**Email channel:** native Gmail API (only). Salesforge and Warmforge were removed entirely — schema, code, types, settings, env, docs. The native channel (`src/lib/gmail/` + `src/lib/native/`) handles sequences, sending, and replies. No remaining Salesforge/Warmforge surface.

**LinkedIn channel:** code-complete via Unipile; not yet activated (gated on migrations + Unipile config).

**Instantly channel (re-added 2026-07-19):** code-complete parallel email channel alongside native Gmail; **not live yet** — gated on applying migration `00065`, adding the API key in Settings, deploying, and registering the reply webhook. Native Gmail is unchanged. Full activation checklist + design decisions in [`RESUME-INSTANTLY-CHANNEL.md`](RESUME-INSTANTLY-CHANNEL.md).

---

## Current email channel: native Gmail API (live)

**Status:** the sole email channel. Sending, warmup ramp, and reply ingest all run through LeadStart's own Gmail-API code (`src/lib/gmail/` + `src/lib/native/`).

**What it does:**

- **Sending** via the `run-native-sequences` cron, which dispatches sequence steps under the per-mailbox warmup ramp in `src/lib/gmail/ramp.ts` (ramps daily send volume up gradually per mailbox rather than blasting at full capacity on day one).
- **Reply ingest** via the `poll-native-replies` cron, which pulls inbound Gmail messages and hands them to the shared reply pipeline for classification + hot-lead notification.
- **Contact import** via client self-service CSV upload into native campaigns (per-campaign token mapping through `/api/campaigns/[id]/client-import`).

---

## Other initiative: LinkedIn Channel via Unipile

**Status:** All 9 code commits shipped (latest `64b45fd`). **NOT live yet** — gated on three migrations + Unipile config + webhook registration. No more code commits required for first activation.

**What it does:** Adds LinkedIn as a parallel outreach channel alongside native email. Per-client hosted-auth connect flow (Unipile-brokered), a sequence builder for multi-step outreach (connect_request → message → message → message), a 15-min cron worker that dispatches steps with per-account safety caps (80 connect/wk, 150 messages/day), and a Unipile webhook handler that ingests inbound DMs into the existing `lead_replies` AI classification + notification pipeline (reuses the email pipeline — `source_channel='linkedin'` is the only row-level difference).

**Resume doc with full activation checklist:** [`RESUME-LINKEDIN-CHANNEL.md`](RESUME-LINKEDIN-CHANNEL.md).

**Decisions locked in:**
- Hosted-auth (Unipile-brokered), not raw OAuth. Owner clicks Connect on the client detail page; client (or owner on their behalf) authorizes via Unipile's hosted page.
- One LinkedIn account per client (their own — not LeadStart's master).
- Reuse the existing AI classification + notification pipeline. No LinkedIn-specific classifier.
- Reply pipeline is channel-agnostic; only the inbound side and the campaign engine differ.
- Cookie expiry every 1–3 months → Unipile fires `account_disconnected` → flips `clients.unipile_account_status='expired'` → Reconnect button surfaces in the LinkedinSection UI.
- No AI auto-drafting on LinkedIn replies.
- Sequence engine: support `connect_request` + `message` for v0; `inmail` / `like_post` / `profile_visit` are reserved kinds until there's a real product use case.

---

## Reply pipeline (channel-agnostic, live for native email)

The Claude classifier + Resend hot-lead notification flow now runs against native email inbound replies (ingested by the `poll-native-replies` cron; LinkedIn DMs will join once that channel activates). Both channels hand off to the same `runReplyPipeline` in [`src/lib/replies/pipeline.ts`](src/lib/replies/pipeline.ts). Two-layer classifier (keyword prefilter → Claude Haiku) per [`src/lib/replies/decide.ts`](src/lib/replies/decide.ts) — the third "upstream tag" layer was removed when Instantly went away.

---

## Prospecting tab — phases shipped

**Phase 1 — Scrap.io plumbing:** API key in Settings, validate-key route, sidebar entry. Commit `2e35b1b`.

**Phase 2 — Background search:** cron-driven worker (`/api/cron/run-prospect-searches`), polling UI for live progress, save-to-CRM with email dedup, prospect_searches table with status lifecycle (migrations 00042 + 00043).

**Phase 3 — Decision-maker enrichment (code-complete):** Two-layer enrichment ported from the standalone LeadEnrich tool. Layer 1 = Claude Haiku scrapes the business website with a category-aware seniority hierarchy. Layer 2 = Perplexity Sonar (or Claude web_search) when the website yields nothing. Surfaced inline on the Scrap.io results table as a "Find decision makers" action; saved contacts get first/last/title/personal_email merged in via a `run_id` on the existing /save endpoint. Settings page gains Anthropic + Perplexity key cards. Migration 00044.

**Phase 3 next:** apply migration 00044, add Anthropic + Perplexity keys in /admin/settings/api, smoke-test end-to-end.

---

## What's Built

### Admin Dashboard (`/admin/*`)
| Page | Status | Notes |
|------|--------|-------|
| Overview | Done | Client cards with health badges, mini KPI metrics, sorted by risk |
| Clients list | Done | Add client form, client detail pages with campaign drill-down |
| Client detail | Done | Per-client campaigns, invite button, campaign-level analytics |
| Campaign detail | Done | KPIs, daily chart, refresh button |
| Campaigns | Done | All campaigns list with status badges |
| New native campaign | Done | Sequence builder for native email campaigns |
| Feedback | Done | Consolidated view of all client feedback with filters |
| Reports | Done | Generate draft → instant preview dialog, email preview, send button, quick date presets |
| Prospects/CRM | Done | Kanban-style pipeline, add/edit prospects |
| Billing | Done | MRR, subscriptions table, invoices, 3 pricing plans, Stripe placeholder |
| Events/Webhooks | Done | Event log with type badges |
| Team settings | Done | Team member list, role management |
| API settings | Done | Anthropic / Perplexity / Scrap.io key cards |

### Client Portal (`/client/*`)
| Page | Status | Notes |
|------|--------|-------|
| Dashboard | Done | Personalized header, KPIs, chart, campaign list. Excluded-meetings counter temporarily 0 (rebuild on native email events). |
| Activity Feed | Done | Real-time event timeline grouped by date. Temporarily empty (rebuild on native email events). |
| KPI Reports | Done | Report history with delivery status, per-campaign metric breakdown with trend arrows |
| My Feedback | Done | Summary cards (total/positive/negative), feedback history table |
| Campaign detail | Done | Per-campaign KPIs, chart, feedback submission form |

### Backend / Cron Workers
| Route | Schedule | Purpose |
|-------|----------|---------|
| `/api/cron/sync-analytics` | hourly | Rolls up native campaign analytics |
| `/api/cron/send-reports` | hourly | Emails KPI reports per client schedule |
| `/api/cron/run-linkedin-sequences` | every 15 min | LinkedIn sequence dispatcher (gated on activation) |
| `/api/cron/run-prospect-searches` | every minute | Scrap.io background search worker |
| `/api/cron/run-decision-maker-enrichment` | every minute | Two-layer decision-maker enrichment worker |
| `/api/cron/expire-replies` | 6am UTC | Marks old replies as expired |
| `/api/cron/retry-notifications` | every 2 min | Resend retry queue |
| `/api/cron/prune-webhook-events` | 4am UTC | Webhook audit log cleanup |
| `/api/cron/dispatch-owner-alerts` | every 5 min | Owner alert delivery |
| `/api/cron/owner-heartbeat` | 1pm UTC | Periodic owner ping |
| `/api/webhooks/unipile` | inbound | LinkedIn DM ingest (gated) |
| `/api/webhooks/resend` | inbound | Email delivery status |

### Database
| Item | Status | Notes |
|------|--------|-------|
| Supabase migrations | Done | 51 migration files in `supabase/migrations/` |
| RLS policies | Done | Row-level security configured |

---

## What's NOT Built Yet

### Priority 1 — Rebuilds after Instantly purge
- [ ] **Client activity feed on native email events**: needs a proper `campaign_id` UUID FK on `webhook_events` + handlers writing to it + client/activity/page.tsx rewiring. Currently the feed renders empty.
- [ ] **Excluded-meetings counter**: same dependency. Currently always shows 0.

### Priority 2 — Email & Communication
- [ ] **Quote/proposal generator**: Branded PDF or HTML quotes for prospects
- [ ] **Automated report scheduling polish**: per-client schedules wired through admin UI
- [ ] **Receipt/invoice emails**: Automated payment confirmations

### Priority 3 — Billing & Payments
- [ ] **Stripe integration**: Connect Stripe account, create products/prices, subscription management
- [ ] **Stripe webhooks**: Handle payment events (succeeded, failed, canceled)
- [ ] **Client checkout flow**: Payment links or embedded checkout for onboarding

### Priority 4 — Polish & UX

#### Pagination audit (complete — commit `ff44ced`, 2026-05-09)
**Convention:** Default page size = 25 rows. Use [`PaginationControls`](src/components/ui/pagination-controls.tsx). Reset page to 1 on filter/sort changes. Counts and stat cards reflect the full filtered set, not the current page slice.

All flagged list views paginated: `admin/clients`, `admin/contacts`, `admin/prospecting`, `admin/feedback`, `admin/inbox` (server fetcher caps at 200), `admin/reports`, `admin/tasks`, `client/inbox`, `client/activity`, `client/feedback`, `client/reports`.

Out of scope: `admin/prospects` (kanban). `admin/campaigns` was paginated earlier at 10 per page; aligning to 25 is a follow-up if desired.

- [ ] **Font upgrade**: Replace default with a cleaner sans-serif (Inter or similar)
- [ ] **Alignment audit**: Verify vertical alignment across all stat cards and metric displays
- [ ] **Mobile responsive**: Test and fix all pages on mobile/tablet
- [ ] **Search functionality**: Make the search bar in topbar actually work
- [ ] **Notification system**: Make the bell icon functional with real notifications
- [ ] **Dark mode**: Theme is configured but not fully tested

### Priority 5 — Advanced Features
- [ ] **Lead read/unread tracking**: Custom status tracking in database
- [ ] **Client onboarding wizard**: Step-by-step flow for new client setup
- [ ] **VA permissions**: Granular access control for what VAs can see/do
- [ ] **Export/download**: CSV/PDF export for reports and data
- [ ] **Audit log**: Track who did what and when

---

## File Structure (Key Files)
```
src/
├── app/
│   ├── (auth)/login/          # Login page
│   ├── (dashboard)/
│   │   ├── admin/             # All admin pages
│   │   ├── client/            # All client pages
│   │   ├── dashboard-shell.tsx # Layout wrapper (sidebar + topbar)
│   │   └── layout.tsx         # Auth check + role detection
│   └── api/
│       ├── cron/              # Scheduled workers (see Backend table above)
│       ├── webhooks/          # unipile, resend, stripe
│       └── admin/             # Owner-only admin endpoints
├── components/
│   ├── charts/                # KPI cards, daily chart, stat card
│   ├── layout/                # Sidebar, topbar
│   └── ui/                    # shadcn components
├── lib/
│   ├── gmail/                 # Native Gmail API client + MIME + warmup ramp
│   ├── native/                # Native channel helpers (token rendering)
│   ├── unipile/               # Unipile client (LinkedIn)
│   ├── replies/               # ingest, prefilter, classifier merge, send
│   ├── ai/                    # Claude classifier + prompt
│   ├── email/                 # Email templates
│   ├── kpi/                   # KPI calculator + health definitions
│   └── supabase/              # Supabase server + admin + browser clients
├── types/app.ts               # TypeScript types
└── middleware.ts              # Auth middleware
```

---

## How to Continue This Project

On any machine with Claude Code or Claude Desktop:
1. Clone the repo: `git clone https://github.com/LeadStart/LeadStart.git`
2. `cd LeadStart && npm install && npm run dev`
3. Tell Claude: "I'm continuing work on the LeadStart project. Read CLAUDE.md and PROJECT_STATUS.md to get up to speed."
4. Claude will read these files and know exactly where things stand.

### To resume a specific in-flight initiative

If there's a "Current Initiative" section above, Claude should also read the linked resume doc. Resume docs live at the repo root (`RESUME-*.md`) and contain decision history + activation checklists.
