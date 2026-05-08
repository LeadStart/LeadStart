<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Local dev — every URL is under `/app`

`next.config.ts` sets **`basePath: "/app"`**. This means:

- Root `http://localhost:3000/` returns **404 by design** (and so does `/login`, `/admin`, etc.). This is NOT a bug.
- Every route lives under `/app`:
  - Login: `http://localhost:3000/app/login`
  - Admin home: `http://localhost:3000/app/admin`
  - Settings: `http://localhost:3000/app/admin/settings/api`
  - Any API route: `http://localhost:3000/app/api/...`
- Production has the same prefix: `https://leadstart-ebon.vercel.app/app/...`

When you start the dev server (via `preview_start` or `npm run dev`), tell the user to open `http://localhost:3000/app/login` — not the bare root. If you see a 404 in your screenshot, check the URL has `/app` before reporting an actual bug.

# Other local-dev quirks (benign — don't chase them)

- **"Multiple lockfiles" warning**: Next.js detects both the main repo's `package-lock.json` and the worktree's. Picks the parent as workspace root. Doesn't break anything; route resolution still works from `cwd`. Silence by running `npm install` inside the worktree.
- **`middleware` file convention is deprecated**: Repo-wide deprecation notice. Migrating to `proxy.ts` is its own task; ignore for now.
- **Strict-null-checks errors in `inbox-health/page.tsx` and a few other pages**: pre-existing project-wide pattern issues. The build passes anyway because `next.config.ts` has `typescript.ignoreBuildErrors: true`. Don't try to fix these unless you're in a file you're already editing — they're not blocking.

# Salesforge / Warmforge

Migration is documented in [docs/salesforge-api-reference.md](docs/salesforge-api-reference.md). One thing to know up front: **Salesforge's API has zero write endpoints for mailboxes** — adding a sender mailbox requires their hosted OAuth flow at app.salesforge.ai. Everything else (sequences, contacts, sending, replies, validation, DNC, analytics) is wired through LeadStart.
