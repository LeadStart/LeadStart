---
name: No AI drafting in reply-routing
description: Claude is for classification only — never add AI drafting, auto-response suggestions, or pre-filled reply text to the portal composer
type: feedback
---

For the LeadStart AI reply-routing pipeline: Claude is used for **classification only** (Haiku). Never add a drafter (Sonnet or otherwise) that pre-fills replies for the client in the portal composer — not even behind an "edit before send" step.

**Why:** The product stance is "signal and dispatch" — classify inbound replies, alert the client, let the human respond on their own. Any AI pre-fill on the outbound side reads as an auto-reply bot, which the owner has explicitly rejected. This was decided 2026-04-21 after a Sonnet 4.6 drafter was shipped in commit #8 (`921bea9`) and removed in `85e4787` the same day. The plan docs and [`RESUME-AI-REPLY-ROUTING.md`](../RESUME-AI-REPLY-ROUTING.md) § Commit #8 record the decision.

**How to apply:**
- When building anything touching `/client/inbox/[id]` composer, `/api/replies/[id]/send`, or future reply-routing commits: no `/draft` endpoint, no Sonnet, no "Generate draft" button, no "Regenerate" button, no auto-complete on the textarea.
- `LeadReply.draft_*` fields are gone from `src/types/app.ts`. The DB columns in migration `00025_create_reply_pipeline.sql` are unused — don't re-adopt them for drafter state; if a `DROP COLUMN` migration is ever run, that's cleanup, not scope reduction.
- Haiku classifier in [`src/lib/ai/classifier.ts`](../src/lib/ai/classifier.ts) is the only approved Claude usage in this pipeline. Adding a new Claude call anywhere in the reply path requires explicit user approval.
