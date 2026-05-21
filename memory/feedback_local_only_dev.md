---
name: Local-only development default
description: Default to local-only development on LeadStart; never push to GitHub until explicitly asked
type: feedback
---

When working on LeadStart, default to local-only development. Never run `git push` without explicit approval from the user. Also never run `git commit` without being asked.

**Why:** LeadStart auto-deploys from master to production. A push = an immediate prod deploy in front of paying clients, with no staging in between. The owner wants to review the working tree before anything lands. Unapproved pushes have shipped broken code in past sessions; this is a recurring failure mode worth being strict about.

**How to apply:**
- Default behavior at the end of every coding turn: **local only**. Describe what changed, ask before committing or pushing.
- Permission is per-change, not per-session. The owner saying "push it" for change A does NOT carry over to change B done later in the same session.
- Trigger words that ARE explicit permission: "commit", "commit and push", "push", "push it", "ship it", "deploy". Anything vaguer — "looks good", "nice", "ok" — is not permission to push; clarify.
- Leave changes as a modified working tree so the owner can review with `git status` / `git diff` before deciding to commit.
- The CLAUDE.md at the project root has a "CRITICAL: Local-only by default" section that says the same thing — that's the authoritative copy. This memory exists so future sessions hit the rule even before reading CLAUDE.md.
