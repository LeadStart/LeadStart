# RESUME — Native Email Channel (rotating Google inboxes)

> Status as of 2026-07-02: **code-complete + reviewed, migration 00056 APPLIED to production, typechecks clean. Code NOT yet deployed to Vercel.** Two gates remain before it can send: (1) push the code to production so the send/poll cron jobs run, and (2) Google Cloud/Workspace domain-wide-delegation setup + add mailboxes. Nothing pushed to git.

## What this is

A first-party email sending channel that lives alongside Salesforge (email) and Unipile (LinkedIn), built the same way the LinkedIn channel was. LeadStart sends cold email **directly** from a pool of client-owned Google Workspace inboxes — rotating across them, pacing per inbox, threading follow-ups, ingesting replies + bounces — with no third-party sequencer.

`source_channel = 'native_email'`. It reuses the existing sequence engine (`campaign_steps` / `campaign_enrollments`) and the channel-agnostic reply pipeline (`runReplyPipeline`).

## Decisions locked with the owner (2026-07-02)

1. **Parallel channel**, not a Salesforge replacement.
2. **Gmail API + service account with domain-wide delegation (DWD)** — no OAuth consent flow, no Google verification. Admin authorizes one service-account client ID per sending domain. SMTP/IMAP connector deferred.
3. **No warmup product.** New inboxes ramp by data: **5 → 10 → 15 → 20/day** over three weeks. Send window **Mon–Fri 8am–5pm ET**.
4. **No tracking** — no open pixel, no link rewriting. Metrics = sent / bounced / replied.
5. **No auto-added opt-out** — no List-Unsubscribe header, no auto footer. Opt-out language lives in the sequence copy. The classifier still auto-blocks contacts who reply "unsubscribe".
6. Simpler over defensive — no benching state machines; surface counts, the owner acts.

## What's built (all local)

**Phase 1 — foundations**
- Migration [`00056_create_native_email_channel.sql`](supabase/migrations/00056_create_native_email_channel.sql): `native_email`/`email` enum values, org SA columns, `native_mailboxes`, `campaign_mailboxes`, `native_sends`, `campaign_steps.subject_template`, sticky-mailbox columns on `campaign_enrollments`, Gmail dedup columns on `lead_replies` (regular UNIQUE for PostgREST upsert).
- [`src/lib/gmail/`](src/lib/gmail): `client.ts` (RS256 JWT via `node:crypto`, DWD impersonation, token cache, typed errors — zero new deps), `mime.ts` (plain-text builder + inbound parser + bounce/auto-reply detection), `ramp.ts` (caps + ET send window via `Intl`), `org.ts` (load client from org creds).
- Settings card (SA email + key), [`/admin/mailboxes`](src/app/(dashboard)/admin/mailboxes) page + CRUD/test-send API, nav entry, types, [runbook](docs/native-email-runbook.md).

**Phase 2 — outbound**
- [`run-native-sequences`](src/app/api/cron/run-native-sequences/route.ts) cron (`*/15`): ramp + window gating, sticky-mailbox rotation, per-mailbox + per-tick caps, threaded follow-ups with Message-ID read-back, `native_sends` logging.
- Native campaign create API + builder page (subject on step 0, mailbox pool), third campaigns-list button, enroll-guard relaxation, campaign-detail native branch.
- Fixed a latent starvation bug: added the SQL channel filter to `run-linkedin-sequences` too.

**Phase 3 — inbound**
- [`poll-native-replies`](src/app/api/cron/poll-native-replies/route.ts) cron (`7,22,37,52`): per-mailbox Gmail poll, bounce branch (→ `contacts.bounced` + enrollment failed), reply branch (thread-match → stop-on-reply gated on auto-reply headers → `lead_replies` → inline `runReplyPipeline`).
- `unsubscribe` → `contacts.status='unsubscribed'` hook in [`pipeline.ts`](src/lib/replies/pipeline.ts) (all channels benefit).

Each phase's diff was adversarially reviewed (multi-agent, findings re-verified); all confirmed findings fixed (Precedence header form; `ilike` wildcard escaping; `NOT IN` filter form).

## Activation checklist

1. ~~**Apply migration 00056**~~ — **DONE** (applied to production `exedxjrifprqgftyuroc` via the Management API on 2026-07-02; all objects verified present).
2. **Deploy the code to production** — `git push origin master`. The `run-native-sequences` (send) and `poll-native-replies` (reply/bounce) workers are Vercel cron jobs; they do not run until the code is deployed. This is the master gate for the channel operating at all. (`CRON_SECRET` is already set in prod.)
3. **Google Cloud + Workspace setup** — follow [`docs/native-email-runbook.md`](docs/native-email-runbook.md): create a GCP project, enable Gmail API, create a service account + JSON key, and authorize its client ID for `gmail.send` + `gmail.readonly` in Google Admin → Domain-wide Delegation, **per sending domain**.
4. **Settings → Integrations → Native Email (Google)**: paste the service-account email + `private_key`. Save.
5. **Sending → Mailboxes**: add each sending address (verified live via the Gmail profile API on add). Click the **Send** test button — a self-send proves delegation end-to-end.
6. **Create a native campaign** (`/admin/campaigns/new/native`): name, client, mailbox pool, steps (subject on the first). Saved as `draft`.
7. **Enroll contacts**, then **Activate** the campaign (the ⋯ menu on the campaigns list → Activate — refuses to activate a native campaign with no mailbox pool or no steps). `run-native-sequences` sends within 15 min during the ET window; follow-ups thread in the same Gmail thread; `poll-native-replies` ingests replies/bounces. Pause/Resume are also available.
8. **Smoke test on owner-owned inboxes** first: a 2-step campaign from 2 mailboxes to ~10 owned addresses + a throwaway that will bounce. Verify: rotation stamps different mailboxes, follow-up threads correctly, ramp caps hold, a reply halts the sequence and appears in `/admin/inbox`, an OOO does **not** halt, a bounce flips the contact to `bounced`. Only then point a client list at it.

**Deliverability (per sending domain, DNS/Google Admin — required for inbox placement):** publish SPF (`include:_spf.google.com`), enable DKIM in Google Admin → Gmail → Authenticate email and publish the DKIM record, publish a DMARC record (`p=none` → tighten to `p=quarantine`), and register the domain in Google Postmaster Tools. Alignment is automatic once the DNS records exist (sends route through Google's own IPs). Put your opt-out line in the sequence copy (no unsubscribe header by design).

## Known environment note (not a bug)

In **local dev**, any route importing the reply pipeline (`poll-native-replies`, the existing Unipile webhook, `retry-notifications`, `send-reports`) 500s on `Can't resolve 'prettier/plugins/html'` from `@react-email/render`. This is **pre-existing** and does not affect production (`send-reports` runs live hourly). It blocks exercising the poller locally; it does not indicate a defect in the native-email code.

## Deferred (Phase 4)

Portal reply-send native branch (replaces the 501 at [`replies/[id]/send`](src/app/api/replies/[id]/send/route.ts) — **must ship before a client replies via the portal**; until then, reply from Gmail directly) · SMTP/IMAP connector · from-address reply matching · per-mailbox timezones · auto-benching on bounce rate.

Separate follow-up (not this project): the Unipile webhook upserts against 00046's *partial* unique index — fix to a regular UNIQUE before the LinkedIn channel activates.

Delete this doc once the first client has shipped on the native channel.
