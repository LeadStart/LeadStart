@AGENTS.md
@PROJECT_STATUS.md

# IMPORTANT: Session Start Protocol
**Every new session MUST run `git pull origin master` before reading or editing any local files.** The codebase is actively developed across multiple machines and Claude sessions. GitHub is the single source of truth — never assume local files are current. Also run `npm install` if package.json changed.

# CRITICAL: Deployment
- **Production URL**: https://leadstart-ebon.vercel.app (LeadStart Vercel account)
- **GitHub**: LeadStart/LeadStart, master branch — auto-deploys on push
- **Deploy by pushing to master**: `git push origin master` — that's it
- **NEVER use `npx vercel --prod`** — that deploys to a personal Vercel account, NOT the LeadStart production site
- **Supabase project**: exedxjrifprqgftyuroc
- **Git author**: daniel@leadstart.io / LeadStart

# LeadStart — Cold Email CMS Platform

## What This Is
A Next.js 16 app for managing cold email campaigns via Instantly.ai. Two dashboards:
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
- Instantly.ai API for campaign data (placeholder client in `src/lib/instantly/`)
- Stripe for billing (placeholder, not wired)
