---
name: project_dev_autologin_route
description: Local preview auth — navigate to /app/api/dev/login to auto-login (dev-only, no password typed).
metadata:
  type: project
---

To view authenticated pages in the local dev preview, navigate to **`/app/api/dev/login`**. Claude cannot type passwords into login forms (safety rule), so this dev-only route (`src/app/api/dev/login/route.ts`) exists instead: it mints a real Supabase session for the user named in `DEV_AUTOLOGIN_EMAIL` (`.env.local`) via service-role `generateLink` + `verifyOtp`, then redirects by role to `/app/admin` (owner/va) or `/app/client`.

- Hit the route once after each dev-server (re)start; it lands you in the dashboard.
- Hard-gated: returns 404 when `NODE_ENV==='production'`, so it's inert on Vercel (prod + preview deploys). Also requires `DEV_AUTOLOGIN_EMAIL`, which only exists in local `.env.local`.
- Daniel's configured account: `daniel.tuccillo92@gmail.com` (owner, actively used). Other owner is `daniel@leadstart.io` — switch by editing the env var.
- Relies on the `.next`-cache fix in [[project_dev_server_next_cache_onedrive]] to compile at all.

Committed + pushed to master 2026-08-22 (route + `.env.example` doc). The `.env.local` value stays local (gitignored) — each machine sets its own.
