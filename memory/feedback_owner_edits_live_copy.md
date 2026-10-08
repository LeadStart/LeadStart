---
name: feedback_owner_edits_live_copy
description: The owner edits campaign copy directly in the LeadStart app; never re-apply an old draft or hard-code expected copy. Always read the LIVE templates and change only the targeted text
metadata:
  node_type: memory
  type: feedback
  originSessionId: 51e46bb0-43e1-46ce-a904-34b1bd5907c4
  modified: 2026-09-28T02:11:36.115Z
---

On 2026-09-27 the owner rewrote the TuBe Email 1 subjects in the app after I had set them. A "{{firm}} on google's ai" / B "{{competitor_1}} on google's ai" became A "{{firm}} is falling behind..." / B "{{competitor_1}} is winning...". My checker, which had the old subjects hard-coded, then reported 224 false problems. The owner: "yes i adjusted copy dont change it back".

**Why:** copy is the owner's. The app is where they edit it, so it is the source of truth. An old draft file or a script that sets whole bodies would silently undo their work.

**How to apply:**
- Before any campaign write, re-read the live flow_graph and change only the exact text targeted, via replace on the live string, and assert the target exists exactly once.
- Never re-run an old apply script that sets whole bodies from a draft (e.g. p73).
- Verification must compare against the live templates, not remembered copy.
- If live copy differs from what I last wrote, treat it as a deliberate owner edit; report it, don't revert it.

Related: [[feedback_no_hidden_copy_variation]], [[project_tube_outreach_pipeline]].
