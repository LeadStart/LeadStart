<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Local dev — every URL is under `/app`

`next.config.ts` sets **`basePath: "/app"`**. Every route lives under `/app/...`:

- Login: `http://localhost:3000/app/login`
- Admin home: `http://localhost:3000/app/admin`
- Settings: `http://localhost:3000/app/admin/settings/api`
- Any API route: `http://localhost:3000/app/api/...`
- Production uses the same prefix: `https://leadstart-ebon.vercel.app/app/...`

`next.config.ts` ALSO declares a few `redirects()` (with `basePath: false`) so the bare URLs `/`, `/login`, `/admin/*`, `/client/*` 307-redirect to their `/app/...` counterparts. This means a user who types `http://localhost:3000/` lands on `/app/login` instead of seeing a 404. **API routes (`/api/...`) are not redirected** — they must be called with the `/app` prefix or they 404.

If you see a 404 on a non-API route, check (a) whether you're hitting an `/app` URL directly, (b) whether the route exists. If it's an API route 404, the cause is almost always a missing `/app` prefix.

# Other local-dev quirks (benign — don't chase them)

- **"Multiple lockfiles" warning**: Next.js detects both the main repo's `package-lock.json` and the worktree's. Picks the parent as workspace root. Doesn't break anything; route resolution still works from `cwd`. Silence by running `npm install` inside the worktree.
- **`middleware` file convention is deprecated**: Repo-wide deprecation notice. Migrating to `proxy.ts` is its own task; ignore for now.
- **Strict-null-checks errors in `inbox-health/page.tsx` and a few other pages**: pre-existing project-wide pattern issues. The build passes anyway because `next.config.ts` has `typescript.ignoreBuildErrors: true`. Don't try to fix these unless you're in a file you're already editing — they're not blocking.

# Salesforge / Warmforge

Migration is documented in [docs/salesforge-api-reference.md](docs/salesforge-api-reference.md). One thing to know up front: **Salesforge's API has zero write endpoints for mailboxes** — adding a sender mailbox requires their hosted OAuth flow at app.salesforge.ai. Everything else (sequences, contacts, sending, replies, validation, DNC, analytics) is wired through LeadStart.
