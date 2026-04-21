# RESUME: AI Reply Routing — Commits 5–12

> **Status as of last push:** see `git log --oneline -1` — latest code commit is commit #9 (pending push).
> **What's done:** commits 1–9 (code-complete; not yet activated in production). ✅ markers on each commit section below.
> **What's left:** commits #10–12 + the one-time "Register webhook" click, deferred until a safe test setup exists.
> **Start here:** scroll to [Commit #10](#commit-10--cron-expire-replies) — commits 5–9 are preserved above it for reference only.
>
> **⚠️ Migration 00028 needs to be applied to Supabase before `/api/replies/[id]/reclassify` will succeed in production.** Run it via `node scripts/supabase-sql.mjs` or the Supabase dashboard. Local dev needs it too if the column writes aren't silently dropped by RLS.
>
> **⚠️ DELETE THIS FILE when commit #12 is merged.** Instructions at the bottom.
>
> ### 🛑 Activation is NOT live yet
>
> Commit #7 shipped the **Register webhook** button, but it has NOT been clicked. The pipeline will not fire on any real Instantly events until an owner clicks that button in production. Do not click it on David Cabrera's active campaign — see ["Activation — do not run yet"](#activation--do-not-run-yet-post-7-todo) below for the specific plan.

This document lets a fresh session pick up the reply-routing build without re-reading the whole plan. Each commit below is scoped to a single, testable unit of work. The full architectural context is still in [`docs/plans/ai-reply-routing.md`](docs/plans/ai-reply-routing.md) — read that first; read this to know *what to build next*.

---

## Quick-start for each new session

1. `git pull origin master` (per [CLAUDE.md](CLAUDE.md)) and confirm you're at or past `3074f48`.
2. Open [`docs/plans/ai-reply-routing.md`](docs/plans/ai-reply-routing.md) — skim the Resume Brief + the "eaccount roundtrip" section.
3. Open this file, find the next unchecked commit, follow its scope + files + verification.
4. Before committing: `npx tsc --noEmit` must be clean on new files; `npx tsx scripts/test-reply-pipeline.mjs` must still pass 104/104 (with `ANTHROPIC_API_KEY` sourced from `.env.local`).
5. Commit and push. Vercel auto-deploys on push to `master`.

---

## Pre-requisites (one-time, check before starting #5)

- [x] `ANTHROPIC_API_KEY` in `.env.local` and Vercel → done 2026-04-21.
- [x] `URL_SIGNING_SECRET` in both envs → done 2026-04-21. See [src/lib/security/signed-urls.ts](src/lib/security/signed-urls.ts) for purpose + token shape.
- [ ] `RESEND_API_KEY` in both envs → already used elsewhere in the app; verify with `grep RESEND_API_KEY .env.local`.
- [ ] `INSTANTLY_API_KEY` in both envs → already present.
- [ ] Migration 00026 applied to Supabase → already applied (check with `node scripts/supabase-sql.mjs "SELECT column_name FROM information_schema.columns WHERE table_name='lead_replies' AND column_name='eaccount'"` — should return one row).
- [ ] David Cabrera's client has `notification_email` + `phone_number` + `persona_*` populated → **not yet**, needed before #12 real smoke test. Can defer until then.

---

## Commit #5 — Resend client-notification email + signed-URL security

> ✅ **SHIPPED in `4f59e4b`** (2026-04-21). Section preserved for reference; skip to commit #8.

**Scope:** Build the "hot lead just landed, call them" email. Plus the HMAC signed-URL helper that makes the email's deep link safe to click without a session.

**New files:**
- `src/lib/security/signed-urls.ts` — HMAC-SHA256, 4h TTL, single-use. Two functions: `signReplyUrl(replyId)` → token string; `verifyReplyUrl(token)` → `{ replyId } | null`. Single-use is enforced by recording the token hash in `lead_replies.notification_token_hash` and rejecting any token whose hash already has `notification_token_consumed_at` set.
    - **Small schema addition needed:** add `notification_token_consumed_at timestamptz` to `lead_replies` in a migration `00027_add_notification_token_consumed.sql`. Keep it in this commit.
- `src/lib/notifications/client-email.tsx` — React Email template (match the existing [`src/lib/email/`](src/lib/email/) patterns). Props: `leadName`, `leadCompany`, `leadPhone`, `classLabel`, `replyBodyPreview`, `dossierUrl`. Subject: `🔔 {leadName} @ {leadCompany} — {classLabel}`.
- `src/lib/notifications/send-hot-lead.ts` — orchestrator. Takes a `LeadReply` row, builds the dossier URL with a signed token, calls Resend. Writes `notified_at` + `notification_token_hash` on the row.

**Edits:**
- `.env.example` — add `URL_SIGNING_SECRET=<generate with openssl rand -hex 32>`.

**Verification:**
- Unit: new file `scripts/test-signed-urls.mjs` that round-trips sign → verify → assert `{replyId}` matches; also assert expired tokens return null; also assert consumed tokens return null.
- Integration: `scripts/send-test-notification.mjs` that fetches a seeded `lead_replies` row and fires a real Resend email to `clients.notification_email`. Guarded behind `SEND_TEST_NOTIFICATION=1`.

---

## Commit #6 — Webhook handler: ingest + tag + classify + notify

> ✅ **SHIPPED in `aa32b60`** (2026-04-21). Section preserved for reference; skip to commit #8.

**Scope:** Wire everything built in commits 3–5 into the live `/api/webhooks/instantly` route. This is the commit where it goes from "all dressed up offline" to "actually running when Instantly fires a webhook."

**New files:**
- `src/lib/replies/tag.ts` — pure function. `correlateTag(event, organizationId)` finds the existing `lead_replies` row by `instantly_message_id` (or creates a placeholder if the tag arrived before `reply_received`) and writes `instantly_category`.
- `src/lib/replies/pipeline.ts` — orchestrator. `runReplyPipeline(replyId)`: fetch the row, run `runKeywordPrefilter` + `classifyReply` + `decideFinalClass`, write the merged result, then (if `final_class ∈ clients.auto_notify_classes`) call `sendHotLeadNotification`.

**Edits:**
- `src/app/api/webhooks/instantly/route.ts` — branch:
  - `event_type === "reply_received"` → build `InstantlyClient` from org API key → call `getEmail(event.instantly_email_id)` to enrich → call `normalizeReplyFromInstantlyEmail` → insert `lead_replies(status='new')` → if `instantly_category` already present (from a prior tag event), schedule `runReplyPipeline` via Next.js `after()`.
  - `event_type.startsWith("lead_")` → call `correlateTag`; if both content + tag now present, schedule `runReplyPipeline`.
  - All other events → existing behavior unchanged.
- `src/lib/instantly/client.ts` — no new methods needed (getEmail already exists from #3).

**Verification:**
- Fire each fixture against a local dev server: `curl -X POST 'http://localhost:3000/app/api/webhooks/instantly?secret=<your WEBHOOK_SECRET>' -H 'Content-Type: application/json' -d @scripts/fixtures/webhook-lead-interested.json`.
- Check: `lead_replies` row appears, `final_class` populated, `notified_at` populated, Resend email delivered to client notification address.
- Regression: other event types (`email_sent`, `email_bounced`, `meeting_booked`) still hit `webhook_events` without side effects.

**Note on `after()`:** Next.js 16's `after()` API should work cleanly. If it doesn't, fallback is to queue into a Supabase table and run a cron worker.

---

## Commit #7 — Register-webhook bootstrap + createWebhook method

> ✅ **CODE SHIPPED in `b4a9858`** (2026-04-21) — but the button has NOT been clicked. See ["Activation — do not run yet"](#activation--do-not-run-yet-post-7-todo) below before touching it. Skip to commit #8 for the next code work.

**Scope:** One-time setup so Instantly actually delivers webhooks to our handler. Admin clicks a button; we POST to `/api/v2/webhooks`; store the returned webhook ID on `organizations.instantly_webhook_id`.

**New files:**
- `src/app/api/instantly/register-webhook/route.ts` — owner-only POST that calls `InstantlyClient.createWebhook`.
- `src/app/(dashboard)/admin/settings/api/register-webhook-button.tsx` — button + state. Disables when `organizations.instantly_webhook_id` is already set.

**Edits:**
- `src/lib/instantly/client.ts` — add `createWebhook({ event_type, url, secret })` → POST `/webhooks`.
- `src/lib/instantly/types.ts` — `InstantlyWebhookCreate` request + response types.
- `src/app/(dashboard)/admin/settings/api/page.tsx` — include the new button.

**Verification:**
- Admin clicks "Register webhook" → row updates → button disables.
- Reply to a test lead in Instantly sandbox → webhook lands → `/admin/inbox` shows new row within ~15s.

---

## Activation — do not run yet (post-#7 TODO)

Commit #7 is code-complete but the button has **not** been clicked. Clicking it once would subscribe Instantly's webhook firehose to our handler, which would immediately start classifying replies and (for clients with `notification_email` set + hot classes in `auto_notify_classes`) firing Resend emails.

**We are NOT going to run this on David Cabrera's production campaign.** The risk is:
- Misclassifications go to a real client's inbox.
- Persona mismatch (David's campaign uses a fake persona; the dossier assumes Path 1 real-person continuity).
- Any pipeline bug becomes a live-customer incident.

**Activation checklist — work through all before clicking "Register webhook":**

- [ ] **Create a dedicated test client + campaign in Instantly.** A separate Instantly campaign we control end-to-end, with a hosted mailbox we own, sending to a short list of test prospects (team members, aliases, or a seed tool). Not David's campaign.
- [ ] **Seed the corresponding LeadStart client row** with `notification_email` pointing at the owner's inbox (daniel@leadstart.io or similar). `phone_number` + `persona_*` populated per Path 1.
- [ ] **Link the test campaign to this client** (`campaigns.instantly_campaign_id` = the test Instantly campaign id).
- [ ] **Verify `clients.auto_notify_classes`** — default includes the hot classes; confirm it's what we want for the test.
- [ ] **Only then** click **Register webhook** on `/app/admin/settings/api`.
- [ ] Reply to a seeded test prospect → confirm dossier email lands → confirm `/admin/inbox` shows the row.
- [ ] If anything misbehaves: unregister via Instantly's UI, clear `organizations.instantly_webhook_id`, fix, repeat.

**David's campaign migration (Path 1) is a separate, downstream action** — see commit #12's pre-requisites. It stays on manual reply handling until the test campaign has fully proven out the pipeline.

---

## Commit #8 — Reply-via-portal send path (manual, no AI drafting)

> ✅ **SHIPPED in `921bea9`** then **pared back** (2026-04-21). Original scope included a Sonnet drafter; owner decided against auto-drafting. Composer is now a manual textarea — the client writes their own reply from scratch. Final shape below.

**Plan change (2026-04-21):** The "Generate draft" button + Sonnet 4.6 drafter were removed after shipping. Rationale: the product stance is "signal and dispatch" — classify replies, alert the client, let the human respond on their own. Any AI-pre-fill on the outbound side risks feeling like an auto-reply bot, even when gated behind an edit step. Claude is used for classification only.

**Shipped files (current):**
- `src/app/api/replies/[id]/send/route.ts` — POST. Atomic `UPDATE ... WHERE status IN ('new','classified')` to prevent double-send; calls `buildReplyRequest` + `InstantlyClient.replyViaEmailsApi`; CCs `clients.notification_email`; writes `status='sent'` + `sent_at` + `sent_instantly_email_id`. Rolls back status + records `error` on Instantly failure so the client can retry with the same body.
- `src/app/(dashboard)/client/inbox/[id]/page.tsx` — "Reply via portal" button opens a composer with a pre-filled `Re:` subject and a blank body textarea. Client types their reply and clicks Send.

**Removed after ship (do NOT re-add without a plan change):**
- `src/lib/ai/drafter.ts`, `src/lib/ai/prompts/drafter-system.ts`, `src/app/api/replies/[id]/draft/route.ts` — all deleted.
- `LeadReply.draft_*` fields removed from `src/types/app.ts`. The corresponding DB columns in migration `00025_create_reply_pipeline.sql` are now unused (safe to leave; ship a follow-up `DROP COLUMN` migration if you want to reclaim them).

**Verification:**
- Open a seeded reply as the client, click "Reply via portal" → composer opens with `Re: <original subject>` pre-filled and an empty body → type a reply → click Send → real Instantly reply API call succeeds, CC'd to `clients.notification_email`, `lead_replies.status = 'sent'`.
- Failure modes: `MissingReplyFieldError` if `eaccount` or `instantly_email_id` is null (should never happen post-#6 but defense in depth).

---

## Commit #9 — Outcome capture API polish + admin reclassify for needs_review

> ✅ **SHIPPED** (2026-04-21). Section preserved for reference; skip to commit #10.
>
> **Migration 00028 must be applied before the reclassify route works** — it adds `reclassified_by`, `reclassified_at`, `reclassified_from` columns.

**Scope:** Replace the direct RLS `UPDATE` in the current dossier with proper API endpoints. Gives us audit logging + server-side validation.

**New files:**
- `src/app/api/replies/[id]/outcome/route.ts` — POST. Atomic update of outcome fields. Writes `outcome_logged_by` from the session.
- `src/app/api/replies/[id]/reclassify/route.ts` — POST, admin-only. Updates `final_class` + bumps status. Writes an audit row somewhere (maybe `webhook_events` with a synthetic event type, or a new `admin_audit_log` table — defer the decision; simplest is adding a column).

**Edits:**
- `src/app/(dashboard)/client/inbox/[id]/page.tsx` — swap the inline `supabase.from('lead_replies').update(...)` for a POST to `/api/replies/[id]/outcome`.
- `src/app/(dashboard)/admin/inbox/[id]/page.tsx` — same for the Reclassify Select; POST to `/api/replies/[id]/reclassify` instead of direct UPDATE.

**Verification:**
- Log an outcome as the client → row updates → admin view reflects it.
- Reclassify a `needs_review` item as admin → `final_class` changes → client view reflects it.

---

## Commit #10 — Cron expire-replies

**Scope:** After 48h with no action (no outcome logged, not sent), mark unresolved hot replies as `expired`. Keeps the inbox clean.

**New files:**
- `src/app/api/cron/expire-replies/route.ts` — auth via `CRON_SECRET` (already present). `UPDATE lead_replies SET status='expired' WHERE status IN ('new','classified') AND received_at < now() - interval '48 hours' AND outcome IS NULL`.

**Edits:**
- `vercel.json` — add the cron schedule. Every 6h is fine (`0 */6 * * *`).

**Verification:**
- Manually hit `curl -H "Authorization: Bearer $CRON_SECRET" https://leadstart-ebon.vercel.app/app/api/cron/expire-replies` → count returned.
- Check Vercel cron logs on the next scheduled run.

---

## Commit #11 — Per-client settings page

**Scope:** Admin UI for managing all the fields on the `clients` table that the pipeline depends on — persona, notification email, phone, brand voice, signature, auto-notify classes.

**New files:** none strictly required; could make a new component file if the existing client detail page gets crowded.

**Edits:**
- `src/app/(dashboard)/admin/clients/[clientId]/page.tsx` — add a "Reply routing" section (collapsed by default) with form fields for: `persona_name`, `persona_title`, `persona_linkedin_url`, `persona_photo_url`, `notification_email`, `phone_number`, `brand_voice` (textarea), `signature_block` (textarea), `auto_notify_classes` (multi-select from `ReplyClass` values).
- `src/app/api/clients/[clientId]/route.ts` (new, or add PATCH to existing) — owner-only update for these fields.

**Verification:**
- Populate all fields for David Cabrera in the admin UI.
- Check DB: every field persists; defaults still apply where unspecified (`auto_notify_classes` keeps the defaults-from-migration value if empty).

---

## Commit #12 — Staging smoke test + merge to master

**Scope:** No new code. Full end-to-end verification against real Instantly + real client onboarding.

**Pre-requisites:**
- The test campaign from the ["Activation" section](#activation--do-not-run-yet-post-7-todo) has been running clean for long enough to trust the pipeline end-to-end (at minimum: one hot reply classified correctly + one unsubscribe silenced + one referral extracted).
- David Cabrera's campaign has been migrated to Path 1 (real persona name in Instantly, real signature). **Owner to do manually in the Instantly UI before this commit.**
- All fields from commit #11 are populated for David's client.

**Smoke test checklist (work through in order):**
1. [ ] Register webhook via admin UI (commit #7 button). Confirm `organizations.instantly_webhook_id` populated.
2. [ ] Reply from a test inbox to a known prospect in David's campaign with: "This is interesting, what's the pricing? Can we chat next week?"
3. [ ] Within ~15s: email arrives at `clients.notification_email` with dossier link + phone number.
4. [ ] Tap dossier link on mobile → page renders with signed token → `tel:` button present → tap it → dialer opens.
5. [ ] Return to dossier → log outcome "called_booked" + note → reflect in admin view.
6. [ ] Reply "I'm not the right person — loop in jane@othercorp.example" → `final_class = 'referral_forward'` in admin inbox, `referral_contact` populated.
7. [ ] Reply "Please remove me" → silent (no notification), row tagged `unsubscribe`.
8. [ ] Test the portal-reply-via-Instantly path: open a hot reply → tap Reply via portal → draft generates → edit → Send → prospect receives reply from the eaccount → `clients.notification_email` receives the CC.
9. [ ] Wait 48h (or manually backdate a `received_at` and hit the cron endpoint) → row expires.

**If all 9 pass:** commit any final bug fixes, push, then delete this file (see below).

---

## When all 12 commits are done: DELETE THIS FILE

Run the following, replacing the commit message if you want something more specific:

```bash
git rm RESUME-AI-REPLY-ROUTING.md
git commit -m "Remove AI reply routing resume doc — all 12 commits shipped"
git push origin master
```

Then update [`PROJECT_STATUS.md`](PROJECT_STATUS.md): remove the "Current Initiative: AI Lead-Reply Classification & Routing" section, since the initiative is complete.

---

## Reference

- Main plan: [`docs/plans/ai-reply-routing.md`](docs/plans/ai-reply-routing.md)
- Instantly reply API: [https://developer.instantly.ai/api-reference/email/reply-to-an-email](https://developer.instantly.ai/api-reference/email/reply-to-an-email)
- Instantly email object: [https://developer.instantly.ai/api-reference/email/get-email](https://developer.instantly.ai/api-reference/email/get-email)
- Last-known-good commit: `3074f48` (commits 1–4 complete)
