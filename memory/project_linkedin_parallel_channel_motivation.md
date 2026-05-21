---
name: linkedin-parallel-channel-motivation
description: Why the Unipile-based LinkedIn channel exists as a parallel to Salesforge, and the cost-model reason it must stay independent.
metadata:
  type: project
---

The Unipile LinkedIn channel is a **deliberate parallel to Salesforge**, not a future replacement. Salesforge bills LinkedIn actions (requests, profile views, etc.) per-social-action on a monthly add-on, which the owner has flagged as unsustainable at any meaningful client volume. Unipile bills per connected account (flat per seat/month), so cost scales with the number of clients with LinkedIn connected — not with sequence step volume.

**Why:** the owner explicitly raised the Salesforge LinkedIn pricing as the reason to keep our own LinkedIn cadence independent. This is the motivation behind the entire Unipile build (commits 1–9 at `64b45fd`), even though the channel was never activated.

**How to apply:** when discussing LinkedIn sequencing or LinkedIn channel changes, default to the Unipile path. Do not propose using Salesforge's LinkedIn step types unless the owner explicitly opts back in. If asked about activation, point at [[linkedin-channel-status]] and the resume doc at [`RESUME-LINKEDIN-CHANNEL.md`](../RESUME-LINKEDIN-CHANNEL.md). The activation gates (3 migrations + Unipile API key/DSN + per-client connect + webhook registration in Unipile dashboard) are owner-side ops, not code work — code is complete.

Two real UI gaps remain before the channel is comfortably owner-driven: (a) no "Activate campaign" button — drafts must be flipped to `active` via DB UPDATE; (b) no bulk-enroll UI — the `POST /api/admin/campaigns/[id]/enroll` route is API-only. Both are flagged in the resume doc's "Next code work" section.
