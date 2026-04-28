# LeadStart — Project Status

> Last updated: 2026-04-27

## Current State: Deployed to Production

Live at https://leadstart-ebon.vercel.app (LeadStart Vercel account, auto-deploys on push to `master`). Real Supabase project (`exedxjrifprqgftyuroc`). Real auth, real data. No mock-mode anywhere — local dev points at the same Supabase.

---

## Current Initiative: LinkedIn Channel via Unipile

**Status:** All 9 code commits shipped (latest `64b45fd`). **NOT live yet** — gated on three migrations + Unipile config + webhook registration. No more code commits required for first activation.

**What it does:** Adds LinkedIn as a parallel outreach channel alongside Instantly email. Per-client hosted-auth connect flow (Unipile-brokered), a sequence builder for multi-step outreach (connect_request → message → message → message), a 15-min cron worker that dispatches steps with per-account safety caps (80 connect/wk, 150 messages/day), and a Unipile webhook handler that ingests inbound DMs into the existing `lead_replies` AI classification + notification pipeline (reuses every line of the email pipeline — `source_channel='linkedin'` is the only difference at the row level).

**Resume doc with full activation checklist:** [`RESUME-LINKEDIN-CHANNEL.md`](RESUME-LINKEDIN-CHANNEL.md).

**Next action when resuming:** apply migrations 00045 + 00046 + 00047 in the Supabase SQL editor, then walk through the activation checklist in the resume doc. After activation, the resume doc lists prioritized post-activation polish commits (Activate-campaign action UI, Bulk-enroll UI, channel-aware dossier, contact resolution, deferred step kinds, analytics-sync cron).

**Decisions locked in:**
- Hosted-auth (Unipile-brokered), not raw OAuth. Owner clicks Connect on the client detail page; client (or owner on their behalf) authorizes via Unipile's hosted page.
- One LinkedIn account per client (their own — not LeadStart's master).
- Reuse the existing AI classification + notification pipeline. No LinkedIn-specific classifier.
- Reply pipeline is channel-agnostic; only the inbound side and the campaign engine differ. Admin inbox + reply pipeline + notification are unchanged.
- Cookie expiry every 1–3 months → Unipile fires `account_disconnected` → flips `clients.unipile_account_status='expired'` → Reconnect button surfaces in the LinkedinSection UI.
- No AI auto-drafting on LinkedIn replies (mirrors the email-channel rule).
- Sequence engine: support `connect_request` + `message` for v0; `inmail` / `like_post` / `profile_visit` are reserved kinds (cron marks them `failed` if used) until there's a real product use case.

---

## Other initiative — AI Lead-Reply Classification & Routing

**Status:** Code-complete through commit #11 per [`RESUME-AI-REPLY-ROUTING.md`](RESUME-AI-REPLY-ROUTING.md); commit #12 is the staging smoke test, not new code. The Instantly webhook is **not** registered in production yet — see the "Activation — do not run yet" section of that resume doc for the gating prereqs (test campaign, David Cabrera persona migration, etc.).

**Security follow-up:** rotate hardcoded Instantly API key at `scripts/backfill-emails.mjs:9` after this work ships.

---

## Prospecting tab — phases shipped

**Phase 1 — Scrap.io plumbing:** API key in Settings, validate-key route, sidebar entry. Commit `2e35b1b`.

**Phase 2 — Background search:** cron-driven worker (`/api/cron/run-prospect-searches`), polling UI for live progress, save-to-CRM with email dedup, prospect_searches table with status lifecycle (migrations 00042 + 00043).

**Phase 3 — Decision-maker enrichment (this commit, code-complete):** Two-layer enrichment ported from the standalone LeadEnrich tool. Layer 1 = Claude Haiku scrapes the business website with a category-aware seniority hierarchy. Layer 2 = Perplexity Sonar (or Claude web_search) when the website yields nothing. Surfaced inline on the Scrap.io results table as a "Find decision makers" action; saved contacts get first/last/title/personal_email merged in via a `run_id` on the existing /save endpoint. New cron worker mirrors the prospect-search pattern. Settings page gains Anthropic + Perplexity key cards. Migration 00044 (`decision_maker_runs` + `decision_maker_results` + 2 org columns).

**Phase 3 next:** apply migration 00044 in Supabase dashboard, add Anthropic + Perplexity keys in /admin/settings/api, smoke-test end-to-end, then ship.

---

## What's Built

### Admin Dashboard (`/admin/*`)
| Page | Status | Notes |
|------|--------|-------|
| Overview | Done | Client cards with health badges, mini KPI metrics, sorted by risk |
| Clients list | Done | Add client form, client detail pages with campaign drill-down |
| Client detail | Done | Per-client campaigns, invite button, campaign-level analytics |
| Campaign detail | Done | KPIs, daily chart, refresh button (placeholder) |
| Campaigns | Done | All campaigns list with status badges |
| Feedback | Done | Consolidated view of all client feedback with filters |
| Reports | Done | Generate draft → instant preview dialog, email preview, send button, quick date presets (7d/30d/MTD/last month) |
| Prospects/CRM | Done | Kanban-style pipeline (lead→contacted→meeting→proposal→closed/lost), add/edit prospects |
| Billing | Done | MRR, subscriptions table, invoices, 3 pricing plans, Stripe placeholder |
| Events/Webhooks | Done | Event log with type badges |
| Team settings | Done | Team member list, role management |
| API settings | Done | Instantly API key config (placeholder) |

### Client Portal (`/client/*`)
| Page | Status | Notes |
|------|--------|-------|
| Dashboard | Done | Personalized header, KPIs, chart, campaign list with status |
| Activity Feed | Done | Real-time event timeline grouped by date, color-coded badges, quick stat cards |
| KPI Reports | Done | Report history with delivery status, per-campaign metric breakdown with trend arrows |
| My Feedback | Done | Summary cards (total/positive/negative), feedback history table |
| Campaign detail | Done | Per-campaign KPIs, chart, feedback submission form |

### Shared Components
| Component | Status | Notes |
|-----------|--------|-------|
| Sidebar | Done | Gradient indigo sidebar, Lucide icons, role-based nav, active state indicator |
| Topbar | Done | Search placeholder, notification bell, user dropdown (profile/settings/switch view/sign out) |
| KPI Cards | Done | Color-coded borders + health badges (good/warning/bad), top colored bar |
| Daily Chart | Done | Area chart with gradient fills, custom legend, styled tooltip |
| Stat Card | Done | Reusable stat card with icon, label, value, optional color |
| Email Template | Done | Branded weekly KPI report email (React Email) with gradient header, metric cards, campaign table |

### Backend / API Routes
| Route | Status | Notes |
|-------|--------|-------|
| `/api/cron/sync-analytics` | Placeholder | Will pull from Instantly.ai API |
| `/api/cron/send-reports` | Placeholder | Will send email via Resend |
| `/api/webhooks/instantly` | Placeholder | Will receive Instantly webhook events |
| `/api/invite` | Placeholder | Will send client invite emails |
| `/api/instantly/test` | Placeholder | Test Instantly API connection |

### Database
| Item | Status | Notes |
|------|--------|-------|
| Supabase migrations | Done | 9 migration files in `supabase/migrations/` |
| Seed data | Done | `supabase/seed.sql` |
| RLS policies | Done | Row-level security configured |
| Mock data | Done | Full mock dataset in `src/lib/mock-data.ts` |

---

## What's NOT Built Yet (Remaining Work)

### Priority 1 — Core Functionality
- [ ] **Connect Supabase**: Create Supabase project, run migrations, connect env vars
- [ ] **Real authentication**: Replace demo mode with actual Supabase auth (login, invite flow, role assignment)
- [ ] **Instantly.ai API integration**: Wire up the API client to pull real campaign data (historical + ongoing sync)
- [ ] **Cron job for analytics sync**: Scheduled pull from Instantly.ai API to populate campaign_snapshots
- [ ] **Deploy to Vercel**: Connect GitHub repo, set env vars, deploy

### Priority 2 — Email & Communication
- [ ] **Resend integration**: Wire up email sending for KPI reports
- [ ] **Gmail API integration**: For personal follow-ups and manual sends (vs automated via Resend)
- [ ] **Quote/proposal generator**: Branded PDF or HTML quotes for prospects
- [ ] **Automated report scheduling**: Set per-client schedules (weekly/biweekly/monthly)
- [ ] **Receipt/invoice emails**: Automated payment confirmations

### Priority 3 — Billing & Payments
- [ ] **Stripe integration**: Connect Stripe account, create products/prices, subscription management
- [ ] **Stripe webhooks**: Handle payment events (succeeded, failed, canceled)
- [ ] **Client checkout flow**: Payment links or embedded checkout for onboarding

### Priority 4 — Polish & UX
- [ ] **Font upgrade**: Replace default with a cleaner sans-serif (Inter or similar)
- [ ] **Alignment audit**: Verify vertical alignment across all stat cards and metric displays
- [ ] **Mobile responsive**: Test and fix all pages on mobile/tablet
- [ ] **Search functionality**: Make the search bar in topbar actually work
- [ ] **Notification system**: Make the bell icon functional with real notifications
- [ ] **Dark mode**: Theme is configured but not fully tested

### Priority 5 — Advanced Features
- [ ] **Lead read/unread tracking**: Custom status tracking in database (Instantly doesn't have native read/unread)
- [ ] **Client onboarding wizard**: Step-by-step flow for new client setup
- [ ] **VA permissions**: Granular access control for what VAs can see/do
- [ ] **Export/download**: CSV/PDF export for reports and data
- [ ] **Audit log**: Track who did what and when

---

## Instantly.ai API Capabilities (Research Complete)

Key findings for when we wire the integration:
- **Authentication**: API key based (query param on v1, Bearer token on v2)
- **Historical data**: YES — can pull retroactive campaign analytics for any time period
- **Lead status updates**: YES — can update lead status via `PATCH /api/v2/leads/{id}`
- **No native read/unread**: Must track in our own database
- **Webhook events**: reply_received, email_sent, email_opened, lead_interested, email_bounced, unsubscribe
- **Rate limits**: ~10 req/sec, paginated responses (100 items/page)
- **Unibox API**: Can pull actual email conversation threads

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
│   └── api/                   # API routes (placeholders)
├── components/
│   ├── charts/                # KPI cards, daily chart, stat card
│   ├── layout/                # Sidebar, topbar
│   └── ui/                    # shadcn components
├── lib/
│   ├── email/                 # Email templates
│   ├── instantly/             # Instantly.ai API client (placeholder)
│   ├── kpi/                   # KPI calculator + health definitions
│   ├── supabase/              # Supabase clients (real + demo)
│   └── mock-data.ts           # All mock data for demo mode
├── types/app.ts               # TypeScript types
└── middleware.ts               # Auth middleware + demo mode routing
```

---

## How to Continue This Project

On any machine with Claude Code or Claude Desktop:
1. Clone the repo: `git clone https://github.com/Kronelius/leadstart.git`
2. `cd leadstart && npm install && npm run dev`
3. Tell Claude: "I'm continuing work on the LeadStart project. Read CLAUDE.md and PROJECT_STATUS.md to get up to speed."
4. Claude will read these files and know exactly where things stand.

### To resume a specific in-flight initiative

If there's a "Current Initiative" section above, Claude should also read the linked plan file under `docs/plans/` — specifically the **Resume Brief** at the top, which captures decisions made, what's next, and what the owner needs to provide.

Example: *"Pick up where we left off on the AI reply routing plan"* → Claude reads `docs/plans/ai-reply-routing.md` → has full context including which commit to start with.
