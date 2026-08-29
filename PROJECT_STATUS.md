# LeadStart — Project Status

> Last updated: 2026-08-29
>
> **Lean current-state index.** This file is `@`-imported by `CLAUDE.md`, so it loads into every session — keep it short. Full per-initiative write-ups, the "What's Built" tables, the file-structure tree, and the backlog detail live in [`docs/PROJECT_STATUS_ARCHIVE.md`](docs/PROJECT_STATUS_ARCHIVE.md) (read on demand — **not** auto-loaded).

## Current State

- **Live in production** at https://leadstart-ebon.vercel.app (LeadStart Vercel account) — **auto-deploys on push to `master`** (no staging).
- **Supabase project** `exedxjrifprqgftyuroc`. Real auth, real data. No mock-mode anywhere; local dev points at the same Supabase.
- **Email channel: native Gmail API only** (Salesforge and Warmforge fully removed — schema, code, types, settings, env, docs). Sequences, sending, the per-mailbox warmup ramp, and reply ingest all run through `src/lib/gmail/` + `src/lib/native/`. Inbox-health scoring, seed-placement tests, and the Million Verifier pre-send gate ride on top (detail in the archive).

## Active / in-flight initiatives

One line each — see the linked RESUME doc (repo root) or the archive for the full write-up.

- **DNS registrar + Google Workspace provisioning** — BUILT (local, unpushed); migration `00097` applied to prod; live activation = **WP7** (registrar/Google keys + scopes + a live provision run remain). → [`docs/plans/deliverability-infrastructure-plan.md`](docs/plans/deliverability-infrastructure-plan.md) §6, `HANDOFF.md`, and the [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Configurable enrichment waterfall** — code-complete (Phases 0–4; site_scrape actor deployed); live activation **gated on Apify budget + Million Verifier key**. → [`RESUME-WATERFALL-SETTINGS.md`](RESUME-WATERFALL-SETTINGS.md).
- **LinkedIn channel via Unipile** — code-complete; **NOT live** (gated on 3 migrations + Unipile config + webhook registration). → [`RESUME-LINKEDIN-CHANNEL.md`](RESUME-LINKEDIN-CHANNEL.md).
- **Instantly channel** — code-complete parallel email channel; **NOT live** (gated on migration `00065` + API key in Settings + deploy + reply-webhook registration). → [`RESUME-INSTANTLY-CHANNEL.md`](RESUME-INSTANTLY-CHANNEL.md).
- **Onboarding / billing redesign** — **IN DESIGN.** Client-facing quote → email → welcome flow + an on-site Stripe payment modal + an admin alert. Mockup at [`mockups/client-facing-quote-billing.html`](mockups/client-facing-quote-billing.html). Open items tracked in the in-app **Tasks** list: native Microsoft channel, SMTP channel, a Workflows → Onboarding live-preview section, and an admin "Quote signed" email.

## Recently shipped

- **Contact-list ↔ campaign variable alignment** — Instantly-style CSV/CRM ↔ merge-variable alignment with a persisted per-campaign registry + fail-safe send (migration `00092`, deployed). → [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Google Maps prospecting vein** — second prospecting vein (Apify compass extractor), owner-name "naming" add-on, delivered-outcome ledger (migrations `00078`/`00079`/`00080`, pushed). → [`RESUME-MAPS-VEIN.md`](RESUME-MAPS-VEIN.md).
- **Catch-all handling + found-first lists** — per-run catch-all-guess add-on + shared email-tier classifier sorting every list found-first. → [`RESUME-MAPS-VEIN.md`](RESUME-MAPS-VEIN.md) / [archive](docs/PROJECT_STATUS_ARCHIVE.md).
- **Pagination audit** — 25/page convention across all flagged list views (commit `ff44ced`). → [archive](docs/PROJECT_STATUS_ARCHIVE.md).

## Backlog — "What's NOT Built Yet"

Priority headlines only; **full detail in the [archive](docs/PROJECT_STATUS_ARCHIVE.md).**

- **P1 — Rebuilds after Instantly purge** (client activity feed + excluded-meetings counter on native email events)
- **P2 — Email & Communication** (quote/proposal generator, report-scheduling polish, receipt/invoice emails)
- **P3 — Billing & Payments** (Stripe integration, webhooks, client checkout)
- **P4 — Polish & UX** (font, alignment, mobile, working search, notifications, dark mode; pagination audit done)
- **P5 — Advanced Features** (lead read/unread tracking, onboarding wizard, VA permissions, export/download, audit log)

## Pointers

- **Full history & reference:** [`docs/PROJECT_STATUS_ARCHIVE.md`](docs/PROJECT_STATUS_ARCHIVE.md) — on-demand, deliberately **not** `@`-imported.
- **Resume docs** live at the repo root: `RESUME-*.md` (`RESUME-INSTANTLY-CHANNEL.md`, `RESUME-LINKEDIN-CHANNEL.md`, `RESUME-MAPS-VEIN.md`, `RESUME-NATIVE-EMAIL.md`, `RESUME-WATERFALL-SETTINGS.md`) — decision history + activation checklists.
