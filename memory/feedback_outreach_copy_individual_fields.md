---
name: feedback_outreach_copy_individual_fields
description: Cold-outreach personalisation goes in as individual custom fields; the sentence lives in the owner-written LeadStart campaign template. No AI-written or pre-assembled per-prospect copy.
metadata:
  node_type: memory
  type: feedback
  originSessionId: e0914236-135a-41c6-a730-575bdd252d2f
  modified: 2026-09-25T18:42:59.370Z
---

Per-prospect data (competitor, city, practice area, rank, report link…) reaches LeadStart campaigns as **individual custom fields**. The owner writes the sentence once, in the campaign template, using `{{tokens}}`. Never ship a pre-written per-prospect "hook" column, and never have AI write copy per prospect.

**Why:** On 2026-09-25 the owner said: "I can't leave this in the hands of AI to do copy writing en masse and we need to keep it as tight as possible, so we'll go for individual fields." They had briefly considered letting TuBe emit the finished hook, then reversed.

**How to apply:**
- Exports and imports carry raw values; wording belongs in the template.
- Avoid token names that collide with LeadStart's standard tokens. Custom fields never override `company`, `firstname`, `title`, `email`, etc. (see `buildTokenMap` in `src/lib/native/tokens.ts`).
- This matches [[feedback_no_ai_drafting]] (Claude classifies; it doesn't draft).

Related: [[project_tube_outreach_pipeline]].
