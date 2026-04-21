---
name: Local-only development default
description: Default to local-only development on LeadStart; never push to GitHub until explicitly asked
type: feedback
---

When working on LeadStart, default to local-only development. Never run `git push` without explicit approval from the user. Also never run `git commit` without being asked.

**Why:** LeadStart auto-deploys from master to production (per CLAUDE.md's "Deploy by pushing to master" section). A push = a deploy, so unapproved pushes can ship broken/unready code to real users. The user wants to review the working tree before anything lands.

**How to apply:**
- In plans that list "commit #N" as units of work (e.g. `docs/plans/stripe-billing.md`, `docs/plans/ai-reply-routing.md`), treat each as a local dev milestone — work that leaves the app runnable, not a trigger to push.
- Leave changes as a modified working tree so the user can review with `git status` / `git diff` before deciding to commit.
- When a milestone is ready, describe what changed and ask before pushing or committing.
