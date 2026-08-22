---
name: project_dev_server_next_cache_onedrive
description: Dev server "Can't resolve tailwindcss" = stale .next cache (OneDrive); wipe .next. Also watch for leaked postcss worker processes.
metadata:
  type: project
---

The repo lives under OneDrive (`C:\Users\dtucc\OneDrive\Documents\Claude\LeadStart-App`), which can corrupt the Turbopack `.next` build cache.

**Symptom:** `next dev` fails to compile with `Error: Can't resolve 'tailwindcss' in 'C:\Users\dtucc\OneDrive\Documents\Claude'` (the project's PARENT dir), even though `globals.css` imports, `postcss.config.mjs`, and tailwind v4 versions are all standard and prod (Vercel/Linux) builds fine.

**What it is NOT:** not a lockfile / workspace-root problem. Setting `turbopack.root` does not fix it — confirmed `__dirname` already = the project dir, and the bad resolution context (parent dir) is independent of `turbopack.root`. Do not add a `turbopack.root` block to `next.config.ts` for this.

**Fix:** delete the `.next` directory and restart the dev server. Regenerating `.next/dev/build/postcss.js` restores the correct resolution base. (`Remove-Item -Recurse -Force .next`)

**Also watch:** every failed compile leaks `.next/dev/build/postcss.js` worker node processes that never get reaped — thousands can pile up (2386 seen 2026-08-22). If the server misbehaves or port 3000 stays bound after a stop, kill stray `node.exe` whose command line contains `LeadStart-App` + `postcss.js`.

Benign side note: a stray `C:\Users\dtucc\package-lock.json` (no package.json/node_modules beside it) triggers Next's "multiple lockfiles" warning. Harmless once `.next` is clean; leave it or delete it — it does not cause the tailwindcss error.
