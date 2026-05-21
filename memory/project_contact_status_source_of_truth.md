---
name: contact-status-source-of-truth
description: Which column actually indicates whether a Salesforge contact has been dispatched — and the trap of treating salesforge_contact_id as a "pushed" flag.
metadata:
  type: project
---

For Salesforge campaigns on this project, the source of truth for "has this contact actually been pushed to this campaign's sequence?" is **`contacts.status`**, not `contacts.salesforge_contact_id`.

**Lifecycle of `contacts.status`** (Salesforge path):
- `'new'` — never touched
- `'queued'` — set by [`/api/admin/contacts/push-to-campaign`](../src/app/api/admin/contacts/push-to-campaign/route.ts) when the operator imports a CSV; the contact is waiting in `salesforge_enrollment_queue` for the daily dispatcher
- `'uploaded'` — set by [the dispatcher](../src/app/api/cron/dispatch-salesforge-enrollments/route.ts) when the Salesforge bulk-create + sequence-enroll succeeds
- Terminal: `'replied'`, `'bounced'`, `'unsubscribed'` — driven by webhook ingest

**`contacts.salesforge_contact_id` is a different thing.** It gets populated by the hourly [`sync-analytics` cron](../src/app/api/cron/sync-analytics/route.ts) (and the manual [refresh-contacts](../src/app/api/admin/campaigns/[id]/refresh-contacts/route.ts) action) from ANY Salesforge workspace presence — even if that contact was created by a different campaign, or has never been enrolled in the current campaign's sequence. The dispatcher itself does not write this column.

**Why this matters for bulk operations:**

A contact can legitimately be `status='queued'` AND have `salesforge_contact_id` populated. Common case: operator re-imports a CSV with emails that already exist in the Salesforge workspace from a previous campaign. Push-to-campaign flips status to 'queued' but does not clear `salesforge_contact_id`.

**Why:** filtering bulk-delete (or any "not yet dispatched" query) on `salesforge_contact_id IS NULL` is the wrong invariant — it silently excludes those re-imported contacts. The user hit this exact bug in the queue-card purge flow: the "Select all N queued in this campaign" link never appeared because the count was artificially low.

**How to apply:** when writing any query that means "scheduled to be sent on this campaign" or "not yet dispatched", filter on `contacts.status = 'queued'` alone, scoped by `campaign_id`. Do not add a `salesforge_contact_id IS NULL` belt — once the dispatcher succeeds, status flips to 'uploaded' and that filter is sufficient.

Related: [[linkedin-parallel-channel-motivation]] (Unipile path uses `campaign_enrollments.status`, not the `contacts.status` lifecycle — that's a separate state machine).
