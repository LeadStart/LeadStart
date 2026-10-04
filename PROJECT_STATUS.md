# LeadStart — Project Status

> Last updated: 2026-10-04
>
> **Lean current-state index.** This file is `@`-imported by `CLAUDE.md`, so it loads into every session — keep it short. Full per-initiative write-ups, the "What's Built" tables, the file-structure tree, and the backlog detail live in [`docs/PROJECT_STATUS_ARCHIVE.md`](docs/PROJECT_STATUS_ARCHIVE.md) (read on demand — **not** auto-loaded).

## Current State

- **Live in production** at https://leadstart-ebon.vercel.app (LeadStart Vercel account) — **auto-deploys on push to `master`** (no staging).
- **Supabase project** `exedxjrifprqgftyuroc`. Real auth, real data. No mock-mode anywhere; local dev points at the same Supabase.
- **Email channel: native Gmail API only.** Salesforge, Warmforge, and Instantly are all fully removed from code, types, settings, env, and UI (Salesforge/Warmforge schema was dropped; the now-empty Instantly columns are left inert). Sequences, sending, the per-mailbox warmup ramp, and reply ingest all run through `src/lib/gmail/` + `src/lib/native/`. Inbox-health scoring, seed-placement tests, and the Million Verifier pre-send gate ride on top (detail in the archive).

## Active / in-flight initiatives

One line each — see the linked RESUME doc (repo root) or the archive for the full write-up.

- **DNS registrar + Google Workspace provisioning**: **LIVE.** Porkbun connected. tubeforseo.com + gettubeseo.com were provisioned 2026-08-31 and are both warming with DKIM live, but their 6 original inboxes were deleted before ~09-07, so both hold 0 inboxes until re-added. **Add inboxes** to any already-set-up domain works in-app since 2026-09-27, with a hard cap of **3 inboxes per domain** on every path. **URL forwarding** shipped (Porkbun via API: apex+www 301; Spaceship dashboard-only), set per-domain from the Mailboxes domain detail or the onboarding wizard's Review step. Reliability hardening (fail-loud DNS on an unconnected registrar, actionable verify-wait, connected-aware wizard picker, half-saved-key warning, current-step status banner) shipped 2026-08-31. → [`docs/plans/deliverability-infrastructure-plan.md`](docs/plans/deliverability-infrastructure-plan.md) §5, `HANDOFF.md`, and the [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Configurable enrichment waterfall** — code-complete (Phases 0–4; site_scrape actor deployed); live activation **gated on Apify budget + Million Verifier key**. → [`RESUME-WATERFALL-SETTINGS.md`](RESUME-WATERFALL-SETTINGS.md).
- **LinkedIn channel via Unipile** — code-complete; **NOT live** (gated on 3 migrations + Unipile config + webhook registration). → [`RESUME-LINKEDIN-CHANNEL.md`](RESUME-LINKEDIN-CHANNEL.md).
- **Onboarding / billing redesign** — **IN DESIGN.** Client-facing quote → email → welcome flow + an on-site Stripe payment modal + an admin alert. Mockup at [`mockups/client-facing-quote-billing.html`](mockups/client-facing-quote-billing.html). The **Workflows → Onboarding live-preview** (Admin → Workflows → Onboarding) is BUILT (local, unpushed) — renders the real proposal-email / hosted-quote / welcome surfaces from live default config, drift-guarded by `scripts/test-onboarding-preview-sync.ts`. Open items still tracked in the in-app **Tasks** list: native Microsoft channel, SMTP channel, and an admin "Quote signed" email.

## Recently shipped

- **Campaign Complete / Reopen** (2026-10-04, `2206d1a` `d2649e6`, audit script `d4e752b`): nothing ever completed a native campaign, so under the one-inbox-one-campaign rule (`src/lib/campaigns/mailbox-usage.ts`) a finished campaign kept its inboxes for good. **Complete** (campaigns ⋯ menu, active or paused) stops sending and frees them; **Reopen** (⋯ menu and the campaign page) takes them back and is refused while another campaign holds one. Pause now runs only from active, Resume only from paused or completed. Manual on purpose, since campaigns are refilled in waves. Rules in `src/lib/campaigns/lifecycle.ts`; test `scripts/test-campaign-lifecycle.ts`; live read-only check `scripts/audit-native-campaign-completion.mjs`. → `HANDOFF.md` 2026-10-04.
- **Campaign Planner + finish dates from the send replay** (2026-10-03, `d0a4292` `b88b298` `4ec29d3`, docs `177adbc`): Admin → Planner. The Campaign tab shows cost, runway, margin and projected replies. The Budget tab has "Per month" (what $X/month buys at steady state) and "Over time" (a monthly budget or one total, month by month for 1-12 months, plus a 1/2/3/6/12-month spread compare). It runs on a tick-by-tick replay of the send dispatcher (`src/lib/planner/engine.ts`, reading `ramp.ts`'s rules), backtested exact against live sends. The campaign page's projected finish date and the heartbeat's "done by" run the same replay from each campaign's live state (`src/lib/planner/live.ts`; `projectSequenceCompletion` is gone): TuBe Nov 13, 2026, David Cabrera May 5, 2027. Cost basis: seat $8.40/mo and domain $11/yr in `src/lib/deliverability/costs.ts`; sourcing $0.08/contact as `PLANNER_DEFAULT_SOURCING_USD` in `src/lib/planner/economics.ts`. Tests: `scripts/test-planner-math.ts`, `scripts/test-planner-timeline.ts`. → `HANDOFF.md` 2026-10-03.
- **Scrap.io search ceilings** (2026-09-29) — after ~1,800 searches locked the account on 2026-09-26, every `/gmap/*` call (app + skill) claims a slot in `scrapio_search_log` first: 150/24h, 400/7 days, 1,000/30 days; searches are never retried (migration `00135`, applied). Rule at the top of `CLAUDE.md`.
- **Saved reply with the TuBe report link** (2026-09-29) — an owner-written reply per campaign (Setup tab) pre-fills the admin inbox with the lead's `{{report_link}}`; the PDF is opt-in, since a PDF reply landed in spam (migration `00134`, applied).
- **`tube-pipeline` skill** (`.claude/skills/tube-pipeline/`) — the TuBe batch runbook: brief → Scrap.io pull → review → import + enrich → TuBe scan → export check → campaign load → verify.
- **Contact-list ↔ campaign variable alignment** — CSV/CRM ↔ merge-variable alignment with a persisted per-campaign registry + fail-safe send (migration `00092`, deployed). → [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Google Maps prospecting vein** — second prospecting vein (Apify compass extractor), owner-name "naming" add-on, delivered-outcome ledger (migrations `00078`/`00079`/`00080`, pushed). → [`RESUME-MAPS-VEIN.md`](RESUME-MAPS-VEIN.md).
- **Catch-all handling + found-first lists** — per-run catch-all-guess add-on + shared email-tier classifier sorting every list found-first. → [`RESUME-MAPS-VEIN.md`](RESUME-MAPS-VEIN.md) / [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Pagination audit** — 25/page convention across all flagged list views (commit `ff44ced`). → [archive](docs/PROJECT_STATUS_ARCHIVE.md).

## Backlog — "What's NOT Built Yet"

Priority headlines only; **full detail in the [archive](docs/PROJECT_STATUS_ARCHIVE.md).**

- **P1 — Rebuilds after the legacy-channel purge** (client activity feed + excluded-meetings counter on native email events)
- **P2 — Email & Communication** (quote/proposal generator, report-scheduling polish, receipt/invoice emails)
- **P3 — Billing & Payments** (Stripe integration, webhooks, client checkout)
- **P4 — Polish & UX** (font, alignment, mobile, working search, notifications, dark mode; pagination audit done)
- **P5 — Advanced Features** (lead read/unread tracking, onboarding wizard, VA permissions, export/download, audit log)

## Pointers

- **Full history & reference:** [`docs/PROJECT_STATUS_ARCHIVE.md`](docs/PROJECT_STATUS_ARCHIVE.md) — on-demand, deliberately **not** `@`-imported.
- **Resume docs** live at the repo root: `RESUME-*.md` (`RESUME-LINKEDIN-CHANNEL.md`, `RESUME-MAPS-VEIN.md`, `RESUME-NATIVE-EMAIL.md`, `RESUME-WATERFALL-SETTINGS.md`) — decision history + activation checklists. (`RESUME-INSTANTLY-CHANNEL.md` is now obsolete — the Instantly channel was fully removed.)
