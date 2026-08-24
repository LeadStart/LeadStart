---
name: project_dev_server_next_cache_onedrive
description: Dev server "Can't resolve tailwindcss" OR serving stale/edited-away source = stale .next cache (OneDrive) or two dev servers sharing .next; kill leftovers on port 3000, wipe .next. Also watch for leaked postcss workers.
metadata:
  type: project
---

The repo lives under OneDrive (`C:\Users\dtucc\OneDrive\Documents\Claude\LeadStart-App`), which can corrupt the Turbopack `.next` build cache.

**Symptom:** `next dev` fails to compile with `Error: Can't resolve 'tailwindcss' in 'C:\Users\dtucc\OneDrive\Documents\Claude'` (the project's PARENT dir), even though `globals.css` imports, `postcss.config.mjs`, and tailwind v4 versions are all standard and prod (Vercel/Linux) builds fine.

**What it is NOT:** not a lockfile / workspace-root problem. Setting `turbopack.root` does not fix it — confirmed `__dirname` already = the project dir, and the bad resolution context (parent dir) is independent of `turbopack.root`. Do not add a `turbopack.root` block to `next.config.ts` for this.

**Fix:** delete the `.next` directory and restart the dev server. Regenerating `.next/dev/build/postcss.js` restores the correct resolution base. (`Remove-Item -Recurse -Force .next`)

**Second symptom (2026-08-24):** the dev server keeps compiling/serving a STALE version of an edited file — build errors point at source you already fixed, and even long-standing top-level `globals.css` rules (`.app-rail`, `.app-shell-content`) vanish from the served CSS while Tailwind's own utilities still work. Cause that day: a leftover `next dev` from the previous session still held port 3000 (so `preview_start` auto-ported a second server) and the two servers shared one `.next`. Fix: check `Get-NetTCPConnection -LocalPort 3000 -State Listen`, kill the stale node PID, wipe `.next`, start one clean server. Don't debug the CSS/JSX itself until this is ruled out.

**Also watch:** every failed compile leaks `.next/dev/build/postcss.js` worker node processes that never get reaped — thousands can pile up (2386 seen 2026-08-22). If the server misbehaves or port 3000 stays bound after a stop, kill stray `node.exe` whose command line contains `LeadStart-App` + `postcss.js`.

Benign side note: a stray `C:\Users\dtucc\package-lock.json` (no package.json/node_modules beside it) triggers Next's "multiple lockfiles" warning. Harmless once `.next` is clean; leave it or delete it — it does not cause the tailwindcss error.
