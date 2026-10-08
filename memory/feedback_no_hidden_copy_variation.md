---
name: feedback_no_hidden_copy_variation
description: "Never keep or add spintax / A-B wording variation in campaign copy without the owner's explicit say; when copy has it, say so plainly up front"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 51e46bb0-43e1-46ce-a904-34b1bd5907c4
  modified: 2026-09-28T01:04:10.691Z
---

On 2026-09-27 the owner saw the TuBe follow-ups (emails 2 + 3) rendered for one contact. I then listed the "alternate wordings other contacts get". The owner was angry: "Alternative wording? Why? Which 'Other contacts'? … we're not doing A/B testing on either of those 2 or 3."

The variation was spintax (`{Following up|Quick follow-up}`, 8 groups). It was already in the campaign's original follow-ups, and I carried it through the copy-v2 update on 2026-09-26 without flagging it.

**Why:** the owner writes and controls the copy word for word. Hidden per-contact variation means they can't know what a given prospect received. It also reads like an A/B test they never approved.

**How to apply:**
- When loading or editing campaign copy, check for spintax (`hasSpintax` in `src/lib/spintax/index.ts`) and flow-graph `variants`.
- Before keeping any of it, tell the owner in plain words: "this email has N wording choices; each contact gets one".
- Default for owner-written copy: one fixed version per email.
- Never present variation as "other contacts get…" without first explaining what it is.

Related: [[project_tube_outreach_pipeline]], [[feedback_outreach_copy_individual_fields]].
