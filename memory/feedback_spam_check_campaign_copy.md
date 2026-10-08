---
name: feedback_spam_check_campaign_copy
description: Spam-check every piece of campaign copy (spam words + SpamAssassin) BEFORE presenting or loading it; owner standing instruction 2026-09-27
metadata:
  node_type: memory
  type: feedback
  originSessionId: 51e46bb0-43e1-46ce-a904-34b1bd5907c4
  modified: 2026-09-28T01:13:00.498Z
---

Owner, 2026-09-27, after I drafted TuBe emails 2 + 3: "you need to be checking for spam words/do a spam test."

**Why:** the owner judges copy partly on deliverability. Presenting copy without a spam check leaves them to ask for it.

**How to apply:** before showing or loading any campaign copy, run both checks and report the results next to the copy.
1. LeadStart's own checker: `scoreCopy(steps)` from `src/lib/deliverability/copy.ts`. It is the campaign editor's spam-word scan, and the phrase list lives in `spam-words.ts`. Target 100/100 with no med/high phrases.
2. A SpamAssassin content score:
   - Build the exact MIME the sender sends (`buildRawEmail` in `src/lib/gmail/mime.ts`, base64url → decode).
   - POST `{email, options:"long"}` to `https://spamcheck.postmarkapp.com/filter` (free, no key).
   - Render with a MADE-UP contact; never send real prospect data to Postmark.
   - Scratchpad pattern: p67 (test) + p68 (spammy control that must score high, 5.8 on 2026-09-27).

Be clear this is a CONTENT test. Inbox placement also depends on sender reputation and domain auth. LeadStart's seed placement test (migration 00068) measures that once sending inboxes exist.

Related: [[feedback_no_hidden_copy_variation]], [[project_tube_outreach_pipeline]], [[project_seed_placement_tests]].
