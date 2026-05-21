@AGENTS.md
@PROJECT_STATUS.md
@memory/MEMORY.md

# IMPORTANT: Session Start Protocol
**Every new session MUST verify the local clone is in sync with GitHub before reading or editing any local files.** The codebase is actively developed across multiple machines and Claude sessions. GitHub is the single source of truth — never assume local files are current.

Run these commands first, every time, and report the result to the user:
1. `git pull origin master` — pull latest
2. `git status` — confirm working tree matches `origin/master` (expect "Your branch is up to date with 'origin/master'")
3. `git log --oneline -5` — show the latest commits so the user can confirm the head is what they expect

Also run `npm install` if `package.json` changed in the pull.

Do not skip this even if the session appears to be a continuation — a different machine or session may have pushed since.

# CRITICAL: Local-only by default — NEVER push or commit without explicit permission

**Do all work locally. Do not `git commit`, do not `git push`, and do not auto-deploy without the owner saying so in the current turn.**

- A `git push` to master triggers a Vercel auto-deploy to production — there is no staging environment. Pushing without explicit permission can put broken code in front of paying clients.
- Commit only when the owner says "commit", "commit and push", "ship it", "push it", "deploy", or similarly direct language for the change at hand. A general OK earlier in the session does NOT carry over to later changes.
- If you finish a change and aren't sure whether to push, **stop and ask**. Default = local only.
- "Verify locally first" means: TypeScript / build check, exercise via the dev preview when applicable, surface what changed in the response — then wait for the owner to greenlight the push.

# Deployment mechanics (for when you DO have permission)
- **Production URL**: https://leadstart-ebon.vercel.app (LeadStart Vercel account)
- **GitHub**: LeadStart/LeadStart, master branch — auto-deploys on push
- **Deploy by pushing to master**: `git push origin master` — that's it
- **NEVER use `npx vercel --prod`** — that deploys to a personal Vercel account, NOT the LeadStart production site
- **Supabase project**: exedxjrifprqgftyuroc
- **Git author**: daniel@leadstart.io / LeadStart

# LeadStart — Cold Email CMS Platform

## What This Is
A Next.js 16 app for managing cold email campaigns via Salesforge.ai. Two dashboards:
- **Admin** (`/admin/*`) — Owner/VA view for managing all clients, campaigns, billing, reports
- **Client** (`/client/*`) — Client-facing portal showing their campaigns, activity, reports, feedback

## How to Run Locally
```bash
npm install
npm run dev
# Opens at localhost:3000 — requires real Supabase env vars in .env.local
```

## Key Architecture Decisions
- **Supabase-only**: No demo/mock mode. `.env.local` must point at the real Supabase project (`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`). If you need to work on the UI offline, branch off and stub data locally — don't reintroduce the demo-client / mock-data paths.
- **Styling**: Bold & branded theme — indigo/violet gradient sidebar, color-coded KPI cards (green=good, amber=warning, red=bad), area charts with gradient fills. All interactive elements use pointer cursor.
- **UI Components**: shadcn/ui (Base UI primitives) + Tailwind CSS v4 + Lucide icons. Custom gradient utilities use inline styles (Tailwind v4 @layer utilities don't reliably generate custom gradient classes).

## Tech Stack
- Next.js 16 (App Router) + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui (Base UI)
- Recharts for data visualization
- Supabase (auth + database) — migrations in `supabase/migrations/`
- Resend + React Email for transactional emails
- Salesforge.ai API for campaign data (`src/lib/salesforge/`) — discovery cron pulls sequences; daily dispatcher enrolls contacts at a per-campaign cap
- Warmforge.ai API for inbox warmup (`src/lib/warmforge/`)
- Unipile API for the LinkedIn channel (`src/lib/unipile/`) — gated on activation
- Stripe for billing (placeholder, not wired)
