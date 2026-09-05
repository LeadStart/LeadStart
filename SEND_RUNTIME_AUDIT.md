# Native Send + Cron Runtime Audit

**Started:** 2026-09-05T08:37:47Z (hard stop 11:22Z, 2h45m wall clock)
**Status:** COMPLETE (fixes shipped locally, nothing pushed). See Reconciliation + Shipped + Open at the end.
**Pathways ticked:** Native send pipeline (Tier 1) + Cron worker fleet (Tier 2)
**Fix gate:** PRE-AUTHORIZED for this run (every CONFIRMED critical/high; medium/low when small + safe). Commits LOCAL only, never pushed.

## Scope

IN: `src/app/api/cron/run-native-sequences/route.ts`, `src/app/api/cron/poll-native-replies/route.ts`,
`src/lib/gmail/*` (ramp, client, mime, org), `src/lib/native/*`, the Million Verifier pre-send gate
(`src/lib/millionverifier/verify-contact.ts`, `org-state.ts`) and the suppression / already-replied checks
they call. PLUS cron-fleet mechanics of all 23 routes under `src/app/api/cron/`: maxDuration coverage,
overlap / at-most-once stance, idempotency, stuck-run recovery, bounded batches, error handling, and the
two routes with no `vercel.json` schedule.

OUT: enrichment phase-machine internals, LinkedIn/Unipile, UI restyling.

## Verification rig

No sandbox Supabase. READ-ONLY only: code reproduction, `scripts/test-*.ts`, read-only prod queries via
the Management API. No email sent, no paid Apify/MV run, no prod mutation.

## Known-vs-assumed ledger

| Claim | Status | Source |
|---|---|---|
| 23 cron routes exist; 21 scheduled in vercel.json; 2 unscheduled (run-decision-maker-enrichment, run-prospect-searches) | VERIFIED | `ls src/app/api/cron`, `vercel.json` |
| 9 routes lack `maxDuration` (dispatch-owner-alerts, expire-replies, prune-webhook-events, reconcile-campaign-tags, retry-notifications, reverify-buyer-contacts, reverify-master-pool, send-reports, sync-analytics) | VERIFIED | grep this run |
| The 2 unscheduled routes were dropped from vercel.json in commit 6818bc0 (Maps vein) | VERIFIED | `git log -S` |
| Their producers (`admin/prospecting/search`, `admin/prospecting/decision-makers/start`) still insert `pending` rows | VERIFIED (code) | route.ts:81-90, :119-126 |
| Vercel cron overlap: "If your cron job runs longer than the interval between invocations, Vercel can trigger a second instance while the first is still running." No built-in lock; docs recommend a lock + idempotency | VERIFIED (docs read 2026-09-05) | https://vercel.com/docs/cron-jobs/manage-cron-jobs (last_updated 2026-08-11), "Controlling cron job concurrency" |
| Vercel cron duplicate delivery: "Cron delivery can also occasionally invoke the same scheduled run more than once. Because of this, cron jobs should be resilient to both missed runs and duplicate runs." | VERIFIED (docs) | same page, "Cron job delivery and idempotency" |
| Vercel cron retries: "Vercel will not retry an invocation if a cron job fails." | VERIFIED (docs) | same page, "Cron job error handling" |
| Vercel cron auth: CRON_SECRET value "will be automatically sent as an Authorization header" with Bearer prefix | VERIFIED (docs) | same page, "Securing cron jobs" |
| Vercel cron GET only, user-agent vercel-cron/1.0, header x-vercel-cron-schedule; timezone always UTC | VERIFIED (docs) | https://vercel.com/docs/cron-jobs |
| Plan is not Hobby: Hobby crons are once-per-day only and "Expressions that run more frequently will fail deployment"; vercel.json deploys six `* * * * *` schedules | VERIFIED by inference from docs + vercel.json | manage-cron-jobs "Cron jobs accuracy" |
| Cron responses that are cached "will not be shown in the logs" (why force-dynamic matters) | VERIFIED (docs) | same page, "Cron jobs logs" |
| Vercel function duration WITH Fluid Compute ("enabled by default"): default 300s on Hobby/Pro/Enterprise; max 300s Hobby, 800s Pro/Enterprise; a function past its max is terminated | VERIFIED (docs read 2026-09-05) | https://vercel.com/docs/functions/configuring-functions/duration (last_updated 2026-08-24), "Duration limits" |
| Whether THIS project has Fluid Compute enabled (dashboard setting; older projects may predate the default) and therefore whether the 9 no-maxDuration routes get 300s or a legacy default | UNKNOWN, needs a dashboard check by Daniel | Vercel project Settings > Functions |
| Cron duration limits "are identical to those of Vercel Functions" | VERIFIED (docs) | manage-cron-jobs, "Cron job duration" |
| A function that does not complete within its duration returns 504 FUNCTION_INVOCATION_TIMEOUT (work done before the kill is NOT rolled back) | VERIFIED (docs) | https://vercel.com/docs/functions/limitations "Max duration" |
| The legacy (non-Fluid) default duration is no longer stated on the current docs pages | UNKNOWN (docs only list Fluid values) | limitations + configuring-functions/duration pages |
| run-native-sequences at-most-once / no-locking is a deliberate stance | VERIFIED (documented) | route.ts:22-26 |

| Gmail API 403 carries BOTH quota reasons (dailyLimitExceeded, rateLimitExceeded, userRateLimitExceeded: "implement exponential backoff") AND a permission reason (domainPolicy); 401 = authError; 429 = too many requests; 5xx = backendError | VERIFIED (docs read 2026-09-05) | https://developers.google.com/workspace/gmail/api/guides/handle-errors |
| src/lib/gmail/client.ts classifyApiError maps EVERY 403 to GmailAuthError (client.ts:312-314), and run-native-sequences benches the mailbox (status=error) on GmailAuthError (route.ts:596-604) | VERIFIED (code) | see SEND findings |
| ABSOLUTE_MAX_DAILY_CAP in code = 20/day/inbox (project memory says the owner law is 25; code is the stricter of the two, not a defect) | VERIFIED (code) | src/lib/gmail/ramp.ts:25 |
| native_sends has NO unique constraint on (enrollment_id, step_index) or on gmail_message_id (per migration files; live DB may drift) | VERIFIED (migration files 00056) | supabase/migrations/00056_create_native_email_channel.sql:134-142 |
| lead_replies UNIQUE (organization_id, gmail_message_id) exists per migration 00056:179 (the poller upsert depends on it) | VERIFIED (migration file) | supabase/migrations/00056:171-179 |
| Gmail users.messages.list: maxResults default 100, max 500; the docs do NOT specify result ordering; pagination via nextPageToken | VERIFIED (docs read 2026-09-05; ordering = UNSPECIFIED) | https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list |
| The poller passes maxResults=25 and ignores nextPageToken (listMessages returns only ids) | VERIFIED (code) | src/lib/gmail/client.ts:203-219, poll-native-replies/route.ts:113-117 |

## Ledger (launch snapshot; the final ledger is at the end of this document)

| Lane | Agent | Status | Candidates | Confirmed | Refuted | Superseded | Clean |
|---|---|---|---|---|---|---|---|
| A send loop (caps/ramp/rotation/pacing/day boundary/overlap) | finder | launched | | | | | |
| B gmail lib (client/mime/org/tokens) | finder | launched | | | | | |
| C poll-native-replies | finder | launched | | | | | |
| D MV gate + suppression | finder | launched | | | | | |
| E cron fleet mechanics (23 routes) | finder | launched | | | | | |
| F cross-module cascades / enrollment state machine | finder | launched | | | | | |
| Bolt-on 1 tsc-to-zero | agent | launched | | | | | |
| Bolt-on 2 RLS delta (12 tables) | agent | launched | | | | | |
| Bolt-on 3 error boundaries | agent | launched | | | | | |

## Findings

### Verifier-found candidates (raised by the lead verifier while reading, pending reconciliation with the finder lists)

- V-1 | critical | src/app/api/cron/send-reports/route.ts:221-300 + src/lib/supabase/middleware.ts:113-115 | The POST handler (manual send from the admin UI) has NO auth check (no checkCronAuth, no requireOwner, no role header check) and the middleware forwards every /api/ request unauthenticated | Anyone on the internet can POST {reportId, recipients:[...]} to email any client KPI report to arbitrary addresses via Resend, or omit reportId to bulk-generate + send reports | Fix: require the owner/va session (house pattern) at the top of POST.
- V-2 | medium | src/app/(dashboard)/admin/clients/[clientId]/campaigns/[id]/refresh-button.tsx:15 + src/app/api/cron/sync-analytics/route.ts (GET only) | The Refresh Now button POSTs to a GET-only cron route → 405 every click; the button silently does nothing | Fix: give sync-analytics an owner-authenticated POST (or point the button at one).
- V-3 | high | src/lib/gmail/client.ts:312-314 + run-native-sequences/route.ts:596-604 | Every Gmail 403 is classified GmailAuthError, but Google documents 403 for quota reasons (rateLimitExceeded, userRateLimitExceeded, dailyLimitExceeded); the route benches the mailbox (status=error) on it | A burst/daily quota 403 permanently benches a healthy inbox until an admin notices | Fix: parse the reason; quota reasons → GmailRateLimitError.
- V-4 | high | src/app/api/cron/poll-native-replies/route.ts:113-120, 311-315 | listMessages caps at 25 per mailbox and the tick budget at 40, but the watermark advances to tickStart after a capped/partial listing | A mailbox with >25 new inbox+spam messages since the watermark (first poll after an error/pause, or a busy inbox) silently loses the older replies/bounces forever | Fix: do not advance last_polled_at past the oldest unprocessed message (or page until exhausted / advance only when listed < cap).
- V-5 | medium | src/lib/gmail/client.ts:156-163, src/lib/google/auth.ts:167 | No fetch timeout/AbortSignal on any Gmail or token call | A hung Google call eats the rest of the 60s budget; the function dies mid-tick (504) with sends made but the enrollment not advanced (duplicate-send precondition) | Fix: AbortSignal.timeout on every fetch.

(populated as verification completes; IDs `SEND-nn` for the send runtime, `CRON-nn` for fleet mechanics)

## Refuted

## Verified clean

## Shipped this session

## Open / Declined

### Lane C: poll-native-replies (verified by the lead verifier by direct code reproduction against every cited line; Finder C ran no scripts)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| SEND-01 | high | CONFIRMED | poll-native-replies/route.ts:113-120, 311-315; gmail/client.ts:203-219 | Listing is capped at 25 per mailbox with no pagination and the tick budget breaks inside the mailbox loop, yet `last_polled_at` still advances to tickStart, so unlisted/unprocessed messages older than the 5-min overlap are never seen again | Code: `listMessages(...,25)` returns ids only (no nextPageToken); `break` at :120; unconditional watermark write at :312. Gmail docs leave list ordering unspecified (ledger), so which messages are lost depends on order, but loss is certain once more than 25 accumulate | Page via nextPageToken up to a bound; count every fetched message + a wall-clock guard; never advance the watermark past a truncated listing. Supersedes V-4 |
| SEND-02 | high | CONFIRMED | poll-native-replies/route.ts:42, 175-210; deliverability/lifecycle.ts:56, 103-109 | An out-of-thread DSN is re-listed every tick for about 5 min and each pass marks the NEXT non-bounced send to that recipient (`.neq("status","bounced").limit(1)`), so one hard bounce becomes N bounced rows; `CB_HARD_BOUNCES_24H = 3` trips the breaker on a single bounce | Code reproduction: the fallback query excludes already-bounced rows, so re-reads walk backwards through the send history | Only mark when the latest send to that address is not already bounced; dedupe by DSN gmail id within the overlap |
| SEND-03 | medium | CONFIRMED (frequency UNKNOWN) | poll-native-replies/route.ts:245-261; gmail/mime.ts:296-306; keyword-prefilter.ts:121-128, 341-345 | Stop-on-reply is decided from headers alone before classification; an auto-reply carrying only `Precedence: bulk`, `X-Auto-Response-Suppress`, or an "Automatic reply" subject flips the contact to replied and the later `ooo` class never reverts it | `isAutoSubmitted` checks Auto-Submitted, X-Autoreply, X-Autorespond and Precedence auto_reply only. How often real OOOs lack Auto-Submitted is UNKNOWN (needs a header sample) | Extend `isAutoSubmitted` (Precedence bulk/junk/list, X-Auto-Response-Suppress, subject patterns) |
| SEND-04 | high | CONFIRMED | poll-native-replies/route.ts:264-294; api/replies/[id]/send/route.ts (claim `WHERE status IN ('new','classified')`) | The upsert payload includes `status: "new"` with `ignoreDuplicates: false`; the same message is re-upserted on every tick for about 5 min, so a reply the VA already handled reverts to `new` and the portal send's atomic claim can pass again | Code reproduction: on-conflict DO UPDATE overwrites status/body/client_id; the send route's claim admits `new` | Insert-only for existing rows (`ignoreDuplicates: true`) and look the id up when the insert is a no-op |
| SEND-05 | medium | CONFIRMED | poll-native-replies/route.ts:222-225 | A thread-matched human reply that Gmail filed under SPAM is dropped even though the thread match proves it answers our own send | The SPAM guard runs before, and regardless of, the `sendRow` check | Drop only unmatched spam |
| SEND-06 | medium | CONFIRMED | replies/pipeline.ts:62-69, 104-108, 178-185; Vercel manage-cron-jobs docs (duplicate delivery VERIFIED) | Row ingest is idempotent but classification + automations + hot-lead email are check-then-act; two overlapping pollers (Vercel duplicate delivery, or the local cron drive) both pass the `final_class` null check | Vercel's docs confirm duplicate/overlapping invocations occur; `reply_status` is a Postgres ENUM (migrations 00025/00036) so a new claim status needs a migration | CAS claim on `classified_at IS NULL` before classification |
| SEND-07 | low | CONFIRMED (assumption unverified either way) | poll-native-replies/route.ts:113-117 vs deliverability/placement-runner.ts:502-506 | The poller relies on `in:spam` inside `q` returning spam without `includeSpamTrash=true`; the placement runner passes `true` for the same purpose | Gmail docs only say includeSpamTrash "Include messages from SPAM and TRASH"; whether `in:spam` alone suffices is UNVERIFIED | Pass `includeSpamTrash=true` (the label filter still excludes TRASH) |
| SEND-08 | medium | CONFIRMED | gmail/mime.ts:229-237, 285-289; poll-native-replies/route.ts:159-210 | `bounceSeverity` reads only the text part and defaults an unparseable DSN to HARD; the `message/delivery-status` part carrying `Action:`/`Status:` is never parsed, so a "Delivery Status Notification (Delay)" whose text has no 4.x.x code suppresses the contact permanently | Code reproduction; whether Gmail delay notices always carry a 4.x.x token in the text part is UNKNOWN | Parse the delivery-status part; treat `Action: delayed`, a "(Delay)" subject, or 4.x.x as soft |
| SEND-09 | medium | CONFIRMED | poll-native-replies/route.ts:127; api/replies/[id]/send/route.ts:169-177 | Only the mailbox's own address is filtered; a reply-all from the client's notification inbox (CC'd on portal replies) is ingested as a lead reply and can DNC the client's own address | Code reproduction | Skip From addresses equal to the campaign client's notification email / CC list |
| SEND-10 | low | CONFIRMED | poll-native-replies/route.ts:66, 89-99, 316-319 | Poll failures are only console.error'd (no `last_error`), and mailboxes in `error` are never polled, so replies to a benched inbox's threads are missed silently | Code reproduction | Persist last_error/last_error_at on poll failure |
| SEND-11 | low | REFUTED as a defect (documented design) | poll-native-replies/route.ts:12-16 | A fresh-thread reply from a known lead address is dropped | The header documents "the poller never ingests arbitrary inbox mail" as a deliberate stance; the gap is real but by design | Open (future From-address fallback) |
| SEND-12 | low | CONFIRMED | run-native-sequences/route.ts:232-236, 564-611 | Reply-halt race: the sender reads contact.status once at tick top; a reply ingested during the tick still gets one more follow-up | Code reproduction; window = poller latency + tick age | Re-read contact status immediately before `sendMessage` |
| SEND-13 | low | CONFIRMED | poll-native-replies/route.ts:36-38; keyword-prefilter.ts:28-30, 75-78 vs pipeline.ts:30, suppression.ts | Stale comments claim "no model call" and an org-wide unsubscribe flip; Claude Haiku IS called and native unsubscribes write a per-client DNC | Code reproduction | Correct the comments |
| SEND-14 | low | CONFIRMED | expire-replies/route.ts:13-15 vs vercel.json | Comment says "every 6h", schedule is `0 6 * * *` (daily) | Code reproduction | Correct the comment |
| SEND-15 | low | REFUTED (intended) | poll-native-replies/route.ts:255-260; migration 00042:47-49 | The replied halt is org-global while DNC is per-client | contacts.status is the repo-wide dispatched-yet signal and one contact row exists per org+email; halting every campaign for a person who replied is the intended behaviour | None |
| SEND-16 | low | CONFIRMED | poll-native-replies/route.ts:103-122, 35, 39 | `processed` counts only matched mail; up to 10 x 25 sequential `getMessage` calls per tick regardless of the 40 budget, no wall-clock guard | Code reproduction | Fold into the SEND-01 fix (fetch cap + deadline) |
| SEND-17 | low | CONFIRMED | gmail/mime.ts:229-237; pipeline.ts:73-75; expire-replies | An attachment-only reply yields an empty body, is never classified, and is expired after 48h; the contact is halted but the reply is lost to the inbox | Code reproduction | Fall back to the Gmail snippet/subject as body_text |

Lane C reconciliation: 17 candidates = 15 confirmed + 2 refuted + 0 superseded. V-4 (verifier) superseded by SEND-01. Verified clean (lane C): 14 areas.

### Lane B: Gmail client / MIME / tokens / org loader (verified: probe script re-run by the lead verifier, Google + Vercel docs, and direct code reproduction)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| SEND-18 | high | CONFIRMED | gmail/client.ts:156-164; google/auth.ts:167; run-native-sequences/route.ts:596-616 | A network-level fetch failure (undici `TypeError: fetch failed`, ECONNRESET, a failing `.text()`) is never caught or classified, so it lands in dispatchEmail's final else and permanently fails the enrollment | Code reproduction: the catch treats every non-Gmail error as `send_failed` | Classify network errors as GmailTransientError inside the client |
| SEND-19 | high | CONFIRMED | gmail/client.ts:312-314; run-native-sequences/route.ts:596-604; placement-runner.ts:216-223 | Every 403 is GmailAuthError and benches the mailbox permanently; Google documents 403 for quota reasons (dailyLimitExceeded, rateLimitExceeded, userRateLimitExceeded) that call for backoff | Google docs read this run (ledger); code reproduction. Supersedes V-3 | Parse `error.errors[0].reason`; quota reasons become GmailRateLimitError |
| SEND-20 | high | CONFIRMED | gmail/client.ts:317; run-native-sequences/route.ts:606-616, 1064-1074 | Every other 4xx is a permanent per-lead failure and the mailbox stays active and least-loaded, so a mailbox-level 400 (mail service disabled) fails every step-0 lead routed to it; failures do not count toward SENDS_PER_TICK, so the whole fetched batch can fail in ONE tick | Code reproduction: pool sort is by load (0 for the broken box), `sent` only increments on success | Bench a mailbox after repeated permanent send failures in one tick and persist the reason |
| SEND-21 | medium | CONFIRMED | google/auth.ts:154-165; gmail/client.ts:300; run-native-sequences/route.ts:596-604 | A bad service-account key is thrown as a per-mailbox auth error, so one tick benches every mailbox in the org and each needs manual reactivation | Code reproduction | Classify signing failures as a config error and skip the org for the tick |
| SEND-22 | medium | CONFIRMED (Gmail's reaction UNKNOWN) | gmail/mime.ts:43-51 | ASCII display names are never quoted; "Smith, John" or "Bob (LeadStart)" emit RFC 5322 specials unquoted (probe re-run) | Probe re-run confirms the raw header; Gmail's acceptance is UNKNOWN | Quote names containing specials |
| SEND-23 | medium | CONFIRMED (status code UNVERIFIED) | run-native-sequences/route.ts:583; gmail/client.ts:317 | A stored `gmail_thread_id` that no longer exists in the mailbox makes the send a permanent failure instead of a fresh thread | Code reproduction; community reports of a 404 are not official docs | On a 404 with threadId, retry once without threadId |
| SEND-24 | medium | CONFIRMED, needs-live-data | run-native-sequences/route.ts:1100-1110, 872-873 | A follow-up with its own subject is sent with the original threadId; Google's threads guide says subjects must match | Cannot be settled without one live send; not reproducible read-only | Live test by Daniel (compare the returned threadId) |
| SEND-25 | low | CONFIRMED | run-native-sequences/route.ts:915-916, 1149-1150; gmail/mime.ts:29-30 | References carries only the parent id, not the chain | Code reproduction; impact limited to non-Gmail clients when an intermediate message is deleted | Open (build the chain from native_sends) |
| SEND-26 | low | CONFIRMED | gmail/mime.ts:43-46 | Non-ASCII subjects over about 47 chars become one encoded-word over RFC 2047's 75-char limit (probe: 96 chars) | Probe re-run | Split into 75-char encoded-words |
| SEND-27 | low | CONFIRMED | gmail/mime.ts:136 | `Date:` uses the obsolete "GMT" zone form | Code reproduction | Emit a numeric zone |
| SEND-28 | low | CONFIRMED | gmail/mime.ts:83-105 | `toFlowed` drops its own space-stuffing and leading indentation (probe) | Probe re-run | Stuff after wrapping |
| SEND-29 | low | CONFIRMED | native/tokens.ts:66-72 | A custom_fields key normalising to a sender/standard token overrides it (probe: `{{YourName}}` hijacked) | Probe re-run; only the CSV importer guards it | Write sender/standard keys last |
| SEND-30 | low | CONFIRMED | native/tokens.ts:112-124; run-native-sequences/route.ts:1232-1233 | A custom value containing `{{...}}` reaches the recipient as literal braces (no double substitution, verified clean) | Probe re-run | Strip stray `{{...}}` from live renders |
| SEND-31 | low | CONFIRMED | gmail/org.ts:14-27 | `maybeSingle()` error discarded, so a DB failure is reported as "not configured" | Code reproduction | Check the error |
| SEND-32 | low | CONFIRMED | gmail/client.ts:21, 304-318; google/auth.ts:246-269 | Stale "15-min cron" comment; the local classifier copy drops `.status` so `isGoogleStatus(err, 404)` can never match a Gmail error | Code reproduction | Thread status through the Gmail error classes |
| SEND-33 | low | CONFIRMED | apify/import-prospects.ts:131 | LinkedIn-prospect import writes the actor email unvalidated; a comma-bearing value becomes a two-recipient To (probe re-run) | Probe re-run + code reproduction | Validate with the CSV importer's anchored regex |
| SEND-34 | medium | CONFIRMED | gmail/client.ts:156; google/auth.ts:167; run-native-sequences/route.ts:67 | No AbortSignal/timeout on any Google fetch; a hung call outlives the 60s function and can die between the send and the native_sends insert | Code reproduction. Supersedes V-5 | `AbortSignal.timeout` on every Google fetch |

Lane B reconciliation: 17 candidates = 17 confirmed (B-17 is the evidence for SEND-34; counted once) + 0 refuted + 0 superseded. V-3 and V-5 superseded. Tests re-run read-only: test-tokens 39/39, test-campaign-variables 46/46, test-google-auth 23/23 (note: it asserts the SEND-19 behaviour and must change with the fix). Verified clean (lane B): 14 areas (To/Subject/From injection closed on every traced path; no Reply-To; body encoding; Message-ID; token minting + cache; token-endpoint classification; 429 and 5xx mapping; config-missing path; applyTokens cannot throw on string input; token semantics incl. prototype keys; in-tick burst bound; no legacy-vendor references).

### Lane F: enrollment / contact / campaign / mailbox cascades (verified by direct code reproduction against the cited lines)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| SEND-35 | high | CONFIRMED | run-native-sequences/route.ts:136-153, 956-957, 1056-1061; client-import/route.ts:357 | The two capped fetches (60 each, oldest first) filter on enrollment status and channel only, not `campaigns.status` nor the sticky mailbox's status, and ineligible rows never advance their sort key, so 60 rows from a draft/paused campaign (or on a paused/error mailbox) permanently starve every other campaign | Code reproduction: `.eq("campaigns.source_channel", ...)` with no status filter; `continue` at :957 and :1061 leaves the row untouched | Filter `campaigns.status = active` in SQL and exclude rows stuck on non-active mailboxes |
| SEND-36 | high | CONFIRMED (Gmail's exact response UNVERIFIED) | admin/mailboxes/[id]/route.ts:176-184; migration 00056:117-120, 160; run-native-sequences/route.ts:1056-1074, 583 | Deleting a mailbox SET-NULLs `native_mailbox_id` on its in-flight sticky enrollments and cascade-deletes its native_sends; the next tick re-homes each mid-thread follow-up to a different inbox carrying the deleted inbox's threadId and In-Reply-To | Code reproduction of both the FK behaviour (per migration file) and the sender's null-mailbox pool pick | Sender: never re-home a mid-thread orphan (fail it with a clear reason); DELETE: fail those enrollments explicitly |
| SEND-37 | high (policy) | CONFIRMED, decision needed | run-native-sequences/route.ts:1056-1061, 991-996; manage-mailbox-lifecycle/route.ts:221-250 | Sticky follow-ups on any non-active mailbox and any paused campaign stall with no age ceiling; on resume every elapsed wait fires, so weeks-late "Re:" follow-ups go out | Code reproduction | Open: a max-staleness rule is a product decision for Daniel |
| SEND-38 | medium | CONFIRMED | run-native-sequences/route.ts:596-604; poll-native-replies/route.ts:61-68 | No owner alert when a mailbox is benched to `error`; the poller stops polling it, so replies to its threads are never ingested | Code reproduction | Enqueue an owner alert on the bench |
| SEND-39 | medium | CONFIRMED | admin/campaigns/[id]/update-sequence/route.ts:165-181; run-native-sequences/route.ts:980-989 | Steps are replaced by delete-all then insert (no transaction); a tick landing in the gap, or a failed insert, makes the sender mark every due enrollment `completed` | Code reproduction | Never auto-complete when a campaign has zero steps |
| SEND-40 | medium | CONFIRMED | enroll-existing/route.ts:89-102; admin/campaigns/[id]/enroll/route.ts:83-101; run-native-sequences/route.ts:1011-1019 | Admin enroll paths do not pre-filter replied/bounced/unsubscribed/DNC contacts, so the sender later flips never-sent enrollments to `replied`, inflating reply metrics | Code reproduction (client-import does filter: 409-436, 479-492) | Pre-filter at enroll; halt a never-sent enrollment as failed with a reason, not replied |
| SEND-41 | medium | CONFIRMED | flow/runtime.ts:231-235; run-native-sequences/route.ts:740-743 | Deleting a flow node that enrollments are parked on completes them silently | Code reproduction | Fail with a visible reason instead of completing |
| SEND-42 | medium | CONFIRMED | ramp.ts:135-144; run-native-sequences/route.ts:453-465; migration 00056:117-118; campaigns/[id]/delete/route.ts:58-61 | The ramp is the native_sends row count and contact/campaign/mailbox deletes cascade those rows, so deleting history rolls inboxes back down the ramp | Code reproduction | Migration: SET NULL instead of CASCADE on native_sends campaign/contact FKs (write, do not apply) |
| SEND-43 | low | CONFIRMED | run-native-sequences/route.ts:929-941, 1164-1175; poll-native-replies/route.ts:249-253 | Post-send enrollment update writes `status: active` with only `.eq("id")`, clobbering a poller `replied` that landed mid-tick | Code reproduction | Guard the update with `.eq("status","active")` |
| SEND-44 | low | CONFIRMED | poll-native-replies/route.ts:168-173, 194-209 | Hard-bounce writes overwrite `replied` enrollments and contacts | Code reproduction | Guard the enrollment update on active; keep replied contacts replied |
| SEND-45 | low | CONFIRMED | campaigns/[id]/delete/route.ts:58-61; poll-native-replies/route.ts:130-137, 228-232 | Deleting a campaign cascades its sends, so later human replies to its threads are dropped | Same root as SEND-42 | Same migration |
| SEND-46 | low | CONFIRMED | enroll-existing/route.ts:134; run-native-sequences/route.ts:1236-1245 | A failed enrollment can never be retried (no reset route) | Code reproduction | Open (feature) |
| SEND-47 | low | CONFIRMED | run-native-sequences/route.ts:856, 880-891; flow/variants.ts:53-59 | A removed A/B variant changes the "Re:" base subject for its follow-ups (cosmetic; threading intact) | Code reproduction | Open |
| SEND-48 | low (policy) | CONFIRMED | enroll-existing/route.ts:87-94; client-import/route.ts:485-502 | No guard against one contact in two concurrent campaigns of the same client; every enroll overwrites `contacts.campaign_id` | Code reproduction | Open (policy) |
| SEND-49 | low | CONFIRMED | admin/campaigns/[id]/link-client/route.ts:136-139 | Re-pointing a live campaign to another client re-scopes DNC | Code reproduction; narrow (needs a deleted-and-re-imported contact) | Open |

Lane F reconciliation: 15 candidates = 15 confirmed + 0 refuted + 0 superseded. Verified clean (lane F): 11 areas (no writer moves replied/bounced/unsubscribed back to sendable, every contacts writer enumerated; same-campaign double enrollment blocked by UNIQUE (campaign_id, contact_id) per migration 00047:82 with ignoreDuplicates on all three enroll paths; started_at defaults to now(); bulk-enroll caps 500/2000/10000/50000; terminal states consistent, `paused` is a dead enum value; lifecycle re-activation resets ramp baseline + clears errors; pool edits never race sticky threads; window edits touch no enrollment state; contact delete cascades cleanly; domain delete SET NULL treated as open; DNC scoping identical in sender and importer).

### Lane D: Million Verifier gate + suppression (verified: Finder D's 46-case harness drives the REAL gateContactVerification; 15 read-only live queries; repo tests 27/27 + 42/42; lead verifier re-read every cited line)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| SEND-50 | high | CONFIRMED | run-native-sequences/route.ts:217-221, 232-237, 980-988, 998-1002 | The campaign_steps and contacts prefetches discard their query errors; an empty map is then read as "no step" (enrollment completed) or "Contact no longer exists" (enrollment failed, terminal), so one transient DB error permanently completes or fails up to 120 enrollments | Code reproduction: `const { data } = await ...` with no error check, then `markEnrollmentFailed` on a missing map entry | Check every prefetch error and abort the tick with 500 before the loop (the enrollment fetch already does) |
| SEND-51 | medium | CONFIRMED | millionverifier/org-state.ts:54-67; verify-contact.ts:74 | ANY error on the organizations SELECT (not only a missing column) disarms the gate for the tick, so sends proceed unverified with only a console.error | Code reproduction; migration 00069's columns are present live (Finder D q1), so the disarm-on-error stance has no remaining reason | Fail closed: abort the tick on load error; disarm only on 42703 |
| SEND-52 | medium | CONFIRMED (harness) | millionverifier/verify-contact.ts:101; org-state.ts:70; run-native-sequences/route.ts:122 | The 30s per-tick verification budget compares the frozen tick timestamp against tickNow + 30s, which can never be true; a run of slow verifications can eat the whole 60s function | Harness case [8]: 30ms past a 1ms deadline still calls | Compare `Date.now()` against the deadline |
| SEND-53 | medium | CONFIRMED | run-native-sequences/route.ts:254-258 vs client-import/route.ts:414-428 | The dnc_entries prefetch discards its error; an empty map means every opted-out contact in the batch is mailed | Code reproduction | Abort the tick on error (same fix as SEND-50) |
| SEND-54 | medium (spend) | CONFIRMED, PARKED (enrichment internals are out of scope) | run-apify-enrichment/route.ts:2139-2157; apify/pattern-mv.ts:137-139 | The pattern finder's paid MV verdict is never written to the contact cache, so the send gate re-verifies and re-bills the same address at first send | Code reproduction by Finder D; the verify PHASE does cache (1695-1700) | Parked as a pathway note for the enrichment audit |
| SEND-55 | medium | CONFIRMED | run-native-sequences/route.ts:820, 1026; admin/campaigns/[id]/link-client/route.ts:136-139 | An active campaign can be unlinked (client_id NULL), after which the DNC check degrades to org-wide rows only, so client-scoped opt-outs stop suppressing it | Code reproduction; live q12 = 0 such campaigns today | Sender: with a null client, any DNC row for the email suppresses |
| SEND-56 | low | CONFIRMED | millionverifier/org-state.ts:150-155, 178; run-apify-enrichment/route.ts:705-727 | Both MV consumers share one org error streak and alert only at streak 1, so whichever trips first swallows the other's alert | Code reproduction | Open |
| SEND-57 | low | CONFIRMED | org-state.ts:117-135; no consumer of native_sends.email_verification_result | Unverified sends are visible only in the cron JSON; no alert or UI counter | Code reproduction; live q11 = 0 disarmed sends since 2026-08-24 | Open |
| SEND-58 | low | CONFIRMED | org-state.ts:201-202; policy.ts:197-199; millionverifier/test/route.ts:60-71 | The low-credits alert needs a persisted balance at or above 500 first; a key saved at 300 credits never gets the alert | Code reproduction | Open |
| SEND-59 | low (policy) | CONFIRMED, decision needed | policy.ts:128-134, 183-189 | Five MV "error" verdicts an hour apart fail the enrollment terminally and skip-cache the contact for 30 days | Owner-confirmed policy (policy.ts:14); live q8 = 0 contacts in error today | Open for Daniel |
| SEND-60 | low | CONFIRMED | poll-native-replies/route.ts:263; replies/suppression.ts:43-55 | The unsubscribe DNC row is keyed on the reply's From address, not the mailed address | Code reproduction | Open |
| SEND-61 | low | CONFIRMED | run-native-sequences/route.ts:16-19 vs policy.ts:10-11, 177-181 | The route header says unknown results hold; the owner policy sends after 3 unknowns flagged risky (10 such live sends) | Code reproduction | Correct the comment |

Lane D reconciliation: 12 candidates = 12 confirmed + 0 refuted + 0 superseded (SEND-54 parked out of scope). Verified clean (lane D): 15 areas (every MV result maps send/skip/hold with no fail-open branch; thrown errors hold + trip the breaker; out-of-credits is fail-closed (vendor sandbox probe: HTTP 200 with an error field); held contacts cost at most one call per hour capped at 3/5; in-tick cache reuse across enrollments; enrichment verify phase shares the cache; DNC writers normalise and the reader matches (live: 0 of 9 rows un-normalised, 0 of 1946 emails mixed-case); contacts.status writers all guarded; gate order never spends a credit on a suppressed contact on either path; already-replied halts org-wide; DNC client scoping conservative; finalizeVerifierStates never throws; enrollment routes drop cached undeliverables; live schema has every 00069 object plus one drift column `contacts.email_verification_provider` in no migration file; live posture 1 org, key set, 7865 credits, streak 0).

### Lane A: send loop caps / ramp / fetch / overlap (verified: Finder A's three simulations + 13 read-only prod queries; lead verifier re-read every cited line and cross-checked against lanes D and F)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| SEND-62 | high | CONFIRMED (prod) | run-native-sequences/route.ts:137-145, 993-995, 748-752 | The follow-up fetch has no due-ness filter: the 60 oldest-actioned rows are fetched whether or not their wait has elapsed, so long-wait rows occupy the window and due short-wait follow-ups are never fetched | Prod q12: 35 of the 60 fetched rows not due; 30 due follow-ups outside the window today. Sim: a 2-day follow-up goes out 9-10 days late | Filter due rows in SQL per campaign (per-step wait thresholds for linear campaigns; min wait for flow campaigns) |
| SEND-35 (merged A-2, A-4, F-1) | critical | CONFIRMED | route.ts:137-153, 955-966, 1056-1061; admin/campaigns/[id]/pause/route.ts:65-68 | No `campaigns.status`, window, or sticky-mailbox eligibility filter in either fetch; paused/draft campaigns and benched mailboxes fill both windows and silently stop every other campaign | Code reproduction (three finders independently); latent today (one active campaign) | Resolve eligible campaigns first, fetch per campaign, exclude rows stuck on non-active mailboxes |
| SEND-63 | high | CONFIRMED | route.ts:146-153 | The first-touch fetch is fleet-global and oldest-started-first, so a campaign with more than 60 queued first-touches blocks every later campaign's first-touches until its queue drains | Code reproduction; the 2026-08-13 two-fetch fix solved the within-campaign case only | Fetch per eligible campaign |
| SEND-64 | high | CONFIRMED (mechanism; likelihood "occasionally" per Vercel) | route.ts:22-26, 1054-1075, 583, 648, 1164-1175; migration 00056 (no unique key on native_sends) | Two overlapping ticks (Vercel duplicate delivery, or the local cron drive) both pass every gate off the same snapshot and both call `gmail.sendMessage` before either writes; the lead gets the same step twice | Vercel docs VERIFIED duplicate/overlapping invocations; prod q3: 0 duplicate (enrollment, step) pairs in 1,802 sends, so it has not fired yet. The documented no-locking stance was tested, not assumed: it holds only if invocations never overlap, which Vercel does not guarantee | Claim the step with a CAS on `current_step_index` before the send; roll back on hold/retry/auth |
| SEND-65 | high | CONFIRMED | route.ts:648-662, 666-670, 929-941, 1164-1175, 1236-1245; postgrest-js returns errors, never throws | Every post-send write ignores its error: a failed advance re-sends the same step next slot; a failed native_sends insert hides a real send from the cap, the ramp and the reply poller | Code reproduction | Check and retry the post-send writes; pair with the SEND-64 claim so the advance precedes the send |
| SEND-50 (merged A-7, D-1) | high | CONFIRMED | see lane D | Prefetch errors read as empty sets | Two finders independently | Abort the tick on any prefetch error |
| SEND-66 | medium | CONFIRMED (sim) | ramp.ts:37-53, 140-143; route.ts:453-465, 530-533 | Graduation thresholds equal the cumulative caps and the cap is re-derived from the live count every tick, so a mailbox graduates mid-day and sends cap+1 (6,7,8..20 instead of 5,6,7..20); never exceeds 20 | Faithful per-tick sim with the real `paced()` gate | Derive the day's cap from the start-of-day count |
| SEND-67 | medium (latent) | CONFIRMED | ramp.ts:171-185; route.ts:418-436; admin/campaigns/[id]/update-sequence/route.ts:47-53, 121-131 | The cap day resets at ET midnight regardless of campaign timezone; a Pacific window ending after 21:00 local straddles the reset and an inbox can send two caps in one local day | Code reproduction; latent (every live campaign uses 8-17, q10) | Reject windows that straddle ET midnight in the validator |
| SEND-68 | medium (cliff at about 50 inboxes) | CONFIRMED (live config) | route.ts:422-426, 442-447, 505-509, 347-350; PostgREST `max_rows = 1000` verified live | Un-limited selects are truncated to 1,000 rows silently; past ~1,000 sends/day some mailboxes read as 0 sent today and the cap stops holding | Live config read by Finder A | Page with `.range()` or aggregate server-side |
| SEND-36 (merged A-11, F-2) | high | CONFIRMED | see lane F | Mailbox delete re-homes live threads | Two finders independently | Never re-home a mid-thread orphan |
| SEND-69 | low | CONFIRMED | ramp.ts:25; migration 00083:28; no per-domain mailbox limit in src | The 75/day/domain law is enforced by convention only: `max_daily_sends` is NULL on every domain and nothing limits mailboxes per domain to 3 | Code reproduction; q8: max 2 mailboxes on one domain today | Open (guard in the mailbox create route or a default cap) |
| SEND-70 | low | CONFIRMED | docs/native-email-runbook.md:205-206 vs ramp.ts:9-14 | Runbook documents the retired weekly ramp | Code reproduction | Correct the runbook |
| SEND-71 | low (policy) | CONFIRMED, decision needed | route.ts:764-768 vs 812-823 | In the flow path a DNC-listed contact still gets LinkedIn VA tasks and internal notifies (only `unsubscribed` stops non-email nodes) | Code reproduction | Open for Daniel: is DNC cross-channel? |

Lane A reconciliation: 14 candidates = 14 confirmed + 0 refuted; of these, A-2 + A-4 merged into SEND-35, A-7 into SEND-50, A-11 into SEND-36 (4 superseded by merges, 10 new IDs). Verified clean (lane A): 21 areas (absolute 20/day ceiling holds in code and in 1,802 prod sends; ramp table arithmetic; sentToday status scope (live CHECK allows only sent/bounced); head:true counts immune to the row cap; spacing gate never divides by zero and fits exactly 20 sends by 16:35 ET; shared-mailbox cap across campaigns; rotation sort + PER_MAILBOX_PER_TICK; ET day boundary vs every window in use; timestamp sources consistent inside one tick; wait-gate parity linear vs flow; new-leads cap semantics match the comments; per-domain cap counting; flow-path parity for email nodes; deleted current_node_id completes rather than restarts; live schema matches every write; 724 active enrollments all on the single active campaign, every sticky pointer resolves; no throw surface inside the loop; cron auth fails closed and no admin run-now trigger exists; schedule overlap by duration alone impossible (60s vs 300s); fleet ceiling 108 inboxes at 20/day; step 0 passes no threadId).

### Lane E: cron fleet mechanics, 23 routes (verified: Vercel doc quotes read this run; lead verifier re-read the middleware, cron-auth, send-reports, sync-analytics, schedule.ts, lifecycle and drain routes; the 23-row table is in the finder transcript and summarised in the ledger)

| ID | Sev | Status | Evidence | Claim | Verification | Fix |
|---|---|---|---|---|---|---|
| CRON-01 | critical | CONFIRMED | cron/send-reports/route.ts:221-223; lib/supabase/middleware.ts:113-115; admin/reports/reports-client.tsx:282-286 | The POST handler had no authentication of any kind and the middleware forwards every /api/ request unauthenticated; anyone could email any client's KPI report to arbitrary recipients or bulk-generate + send reports for every client | Lead verifier read both files; supersedes V-1 | Owner/VA session required (shipped) |
| CRON-02 | medium | CONFIRMED | admin/.../refresh-button.tsx:15-17; cron/sync-analytics/route.ts (GET only); Next route-handler docs (405 on unsupported method) | The "Refresh Now" button POSTs to a GET-only cron route, so every click is a silent 405 | Lead verifier; supersedes V-2 | Session-gated POST on sync-analytics (shipped) |
| CRON-03 | medium | CONFIRMED | cron/poll-native-replies/route.ts:120-310 (old), 316-319 | No per-message try/catch: a malformed or vanished message pinned the whole mailbox at its watermark forever | Code reproduction | Per-message isolation (shipped in the poller rewrite) |
| CRON-04 | low | CONFIRMED | lib/security/cron-auth.ts:39-42 | Plain `!==` bearer comparison | Code reproduction | timingSafeEqual (shipped) |
| CRON-05 | low | CONFIRMED | nine routes with no maxDuration; Vercel docs (300s Fluid default, dashboard toggle UNVERIFIED) | Budget depended on a dashboard setting | Docs read this run | Explicit maxDuration on all nine (shipped) |
| CRON-06 | low | CONFIRMED | vercel.json (both `0 * * * *`); sync-analytics upsert vs send-reports read | send-reports raced the :00 snapshot rewrite | Code reproduction | send-reports at :05 (shipped) |
| CRON-07 | medium | CONFIRMED | cron/send-reports/route.ts:87-89, 165-168; lib/kpi/schedule.ts:47 | "Next-hour retry" comments were false: the due check matched the exact hour only, so a failed send waited for the next weekly/biweekly/monthly slot while a "Draft" kpi_reports row sat in the client portal | Lead verifier read schedule.ts | Due from the scheduled hour onward on the scheduled day (shipped); the pre-send kpi_reports insert is still Open |
| CRON-08 | low | CONFIRMED | cron/manage-mailbox-lifecycle/route.ts:209-218 vs poll-native-replies breaker CAS | Lifecycle transitions were not compare-and-set on the from-state and could overwrite a concurrent breaker trip | Lead verifier read the update | CAS + skip on race (shipped) |
| CRON-09 | medium | CONFIRMED (finder evidence), PARKED (enrichment internals out of scope) | cron/run-apify-enrichment/route.ts:545-557, 571-584 | The run lease is released inside setActive before the same-tick ingest; an overlapping invocation can re-claim the run, double-count the batch cost and start a second paid batch | Not independently re-read (out of scope) | Parked to the enrichment pathway |
| CRON-10 | high | SUPERSEDED by SEND-01 | poll-native-replies watermark | Same finding as C-1 | | |
| CRON-11 | medium | CONFIRMED (re-read) | cron/run-linkedin-searches/route.ts:125-131; cron/run-maps-searches/route.ts:370-377 | One search per tick, FIFO across every org: each queued search waits for everything ahead of it; a stuck actor blocks all for 20 min | Lead verifier re-read the claim queries | Open (round-robin needs a column) |
| CRON-12 | low-medium | CONFIRMED (re-read) | cron/drain-enrichment-queue/route.ts:24-45 | The drain picks the org owning the single oldest queued contact and returns org_busy without trying another org | Lead verifier re-read | Open (moot with one org) |
| CRON-13 | low-medium | CONFIRMED | cron/reverify-buyer-contacts/route.ts:55-68, 91-122 | No lease; `processed` persisted only at tick end, so an overlap re-verifies the same slice at MV cost | Code reproduction | maxDuration=60 shipped; lease needs a column (Open) |
| CRON-14 | low-medium | CONFIRMED (re-read) | cron/advance-domain-provisioning/route.ts:92-98; deliverability/provisioning-runner.ts:356-366 | The cron path discards `revealed_passwords`, so a Workspace user the cron creates has an unrecoverable password (DWD sending unaffected) | Lead verifier re-read | Open for Daniel (owner-driven step vs digest) |
| CRON-15 | low | CONFIRMED | cron/run-prospect-searches + run-decision-maker-enrichment (no schedule since 6818bc0); producers admin/prospecting/search + decision-makers/start (no UI caller) | Both workers are DEAD: no schedule, no other trigger, no UI path to the producers; docs still list them as every-minute crons | Lead verifier grepped triggers + producers | Archive doc corrected (shipped); route deletion recommended (Open) |
| CRON-16 | low | CONFIRMED | .github/scripts/validate-vercel-json.mjs:51-57 | CI validator checks neither the /app basePath nor that every cron dir has a schedule | Code reproduction | Open |
| CRON-17 | low | CONFIRMED | lib/notifications/owner-alerts.ts:188-231 | Owner-alert digest has no attempt counter or dead-letter; a permanently failing Resend retries the growing digest every 5 min forever | Code reproduction | Open |
| CRON-18 | low | CONFIRMED | send-reports:121-127, 182-185; owner-heartbeat:59-65; retry-notifications:151-159; run-placement-tests:167-183 | Read-then-act senders with no claim under Vercel's documented duplicate delivery (double report / heartbeat / retry email / probe) | Vercel docs + code | Open (cheap CAS claims recommended) |

Lane E reconciliation: 18 candidates = 17 confirmed + 0 refuted + 1 superseded (CRON-10 = SEND-01). CRON-02 is the holder for V-2 (V-2 counted as superseded). Verified clean (lane E): 18 areas (auth-first on all 23 GETs with fail-closed secret; force-dynamic on all 23; every vercel.json path carries /app and Vercel does not follow redirects; atomic 90s leases on the three paid sourcing/enrichment workers with stuck-abort + 3-strike breakers; one-active-run-per-org DB invariant; token settlement idempotent by unique index; provisioning idempotent (Google 409 = resume, Porkbun read-diff-write, CAS state); placement stuck recovery; hot-lead retry dead-letter; reply ingestion idempotent at row level; analytics upsert idempotent; single-statement crons; per-item error isolation in every multi-row route except the old poller loop; plan is not Hobby; Vercel never retries and every route is a reconciliation loop; header contract is Bearer only; :00 herd absorbed).

## Reconciliation

**98 candidates = 86 confirmed + 2 refuted + 10 superseded. 93 areas verified clean.**

- Candidates by source: Finder A 14, Finder B 17, Finder C 17, Finder D 12, Finder E 18, Finder F 15 (93) + 5 raised by the lead verifier while reading (V-1..V-5).
- Superseded (10): V-1 by CRON-01, V-2 by CRON-02, V-3 by SEND-19, V-4 by SEND-01, V-5 by SEND-34, A-4 and F-1 merged into SEND-35, D-1 merged into SEND-50 (A-7 holds the ID), F-2 merged into SEND-36 (A-11), E-3 (CRON-10) by SEND-01.
- Refuted (2): SEND-11 (fresh-thread replies are dropped by a documented design stance), SEND-15 (the org-wide replied halt is the intended "dispatched-yet" signal).
- Confirmed (86): 71 SEND-nn (01..71, minus the 2 refuted, plus the merged holders) + 17 CRON-nn (01..18 minus CRON-10). Two confirmed items are PARKED as out of scope (SEND-54, CRON-09: enrichment internals) and recorded as pathway notes in AUDITS.md.
- Verified clean by lane: A 21, B 14, C 14, D 15, E 18, F 11 = 93.
- Verification methods: lead verifier re-read of every cited line for the critical/high items and every fix target; Finder B's hostile-input MIME probe re-run by the lead verifier; Finder D's 46-case harness against the real gate; three simulations and 13 read-only prod queries by Finder A; 15 read-only prod queries by Finder D; live RLS catalog reads by the RLS lane; Vercel and Google docs read this run for every platform claim. Low-severity lane F cascade items (SEND-46..49) were accepted on the finder's exhaustive writer matrix without a second read.

## Shipped this session (all LOCAL commits on master, NOT pushed)

| Commit | Cluster | Findings closed |
|---|---|---|
| 9dbae48 | Cron fleet | CRON-01 (critical), CRON-02, CRON-04, CRON-05, CRON-06 |
| 96c448d | Send runtime + Gmail client | SEND-18, 19, 20, 21, 23, 32, 34, 35, 36, 38, 39, 40 (halt half), 43, 50, 51, 52, 53, 55, 61, 62, 63, 64, 65, 66; SEND-12 closed as a consequence of the SEND-64 claim (status-guarded CAS before every send) |
| 7bed81c | Reply poller + MIME | SEND-01, 02, 03, 04, 05, 07, 08, 09, 10, 13, 14, 16, 17, 44 (enrollment guard), CRON-03 |
| 75a6bef | Small confirmed items | SEND-22, 27, 29, 31, 33, 70; CRON-07, CRON-08 |
| 43e5031 | Bolt-on 3: error boundaries | admin/client/buyer error.tsx + global-error.tsx + shared RouteError card |
| f9d9536 | Bolt-on 1: tsc to zero | 94 to 0 errors, ignoreBuildErrors=false, `npm run build` passes twice with type checking on; 2 real runtime bugs fixed on the way |
| d7081f1 | Bolt-on 2: RLS delta | migration 00126 written (NOT applied): push_subscriptions policy scoped to org + owner/va; REVOKE on 3 service-role-only tables |

Verification per cluster: `npx tsc --noEmit` exit 0 after every cluster; `scripts/test-google-auth.ts` 23/23, `test-tokens.ts` 39/39, `test-millionverifier-policy.ts` 42/42, `test-millionverifier-client.ts` 27/27, `test-flow-map-sync.ts` 11/11, `test-campaign-variables.ts` 46/46; the MIME hostile-input probe re-run shows quoted display names and neutralised CRLF; `npm run build` green (bolt-on 1). No email was sent, no paid run started, no prod mutation; prod reads were SELECT-only.

Not runtime-verified (no sandbox, and the only way to exercise the sender is a real send to a real lead): the claim/release path in run-native-sequences, the per-campaign PostgREST `or(...)` due filters, and the poller's paged listing. They are type-checked and desk-checked line by line; the first production tick after a push is the real test, so watch the cron JSON for `claimed_elsewhere`, `deadline_hit`, `truncated` and any 500 with "prefetch failed".

## Open (confirmed, not shipped)

Policy decisions for Daniel:
- SEND-37: max-staleness rule for follow-ups after a long pause/rest (weeks-late "Re:" mail).
- SEND-59: MV "error" x5 permanently fails a lead; keep, or send-flagged-risky like unknown.
- SEND-71: is DNC cross-channel (LinkedIn tasks / internal notifies for a DNC'd contact)?
- SEND-48: one contact in two concurrent campaigns of the same client.
- CRON-14: cron-created Workspace users have unrecoverable passwords (leave user creation to the owner-driven step, or surface them).
- SEND-69: enforce 3 inboxes/domain or default `max_daily_sends` to 75 (the volume law is convention today).

Needs a migration (written as a proposal, not a file):
- SEND-42 / SEND-45: `native_sends.campaign_id` and `contact_id` FKs are ON DELETE CASCADE, so deleting history rolls inboxes back down the ramp and drops later replies; change to SET NULL and make the poller tolerate null campaign_id (skip the reply branch, keep bounce marking).
- SEND-06: CAS claim on lead_replies before classification (no enum change needed: use `classified_at IS NULL` as the token and reset it on a failed classification).
- CRON-13 / CRON-11 / CRON-12: leases and round-robin for reverify-buyer-contacts, the sourcing crons and the enrichment drain.

Needs a live test (cannot be settled read-only):
- SEND-24: a follow-up with its own subject sent with the original threadId (Google's guide says subjects must match); compare the returned threadId once.

Small code items left over (all low): SEND-25 (References chain), SEND-26 (encoded-word length), SEND-28 (flowed stuffing), SEND-30 (stray braces from values), SEND-41 (missing flow node completes silently, by design at runtime.ts:231), SEND-46 (retry-failed action), SEND-47, SEND-49, SEND-56, SEND-57, SEND-58, SEND-60, SEND-67 (window validator), SEND-68 (the other un-ranged selects; sentToday is paged now), CRON-15 (delete the two dead Scrap.io routes + 7 producer routes + settings UI), CRON-16 (CI validator), CRON-17 (owner-alert dead-letter), CRON-18 (duplicate-invocation claims for reports / heartbeat / retries / probes), CRON-07's pre-send kpi_reports insert (a failed send leaves a client-visible Draft).

Parked out of scope (enrichment pathway): SEND-54 (pattern-finder verdict never cached, double MV bill at send), CRON-09 (lease released before the same-tick ingest).

## Declined / by design

- SEND-11: fresh-thread replies from a known lead address are dropped; the poller header documents "never ingests arbitrary inbox mail". Revisit only with a From-address fallback design.
- SEND-15: the replied halt is org-global on purpose (contacts.status is the dispatched-yet signal, one contact row per org+email).

## Ledger (final)

| Lane | Candidates | Confirmed | Refuted | Superseded | Clean |
|---|---|---|---|---|---|
| A send loop | 14 | 13 | 0 | 1 (A-4 into SEND-35; A-2, A-7 and A-11 are the holders of SEND-35, SEND-50, SEND-36) | 21 |
| B gmail lib | 17 | 17 | 0 | 0 | 14 |
| C poller | 17 | 15 | 2 | 0 | 14 |
| D MV gate | 12 | 11 | 0 | 1 (D-1 into SEND-50) | 15 |
| E fleet | 18 | 17 | 0 | 1 (E-3 into SEND-01); CRON-02 holds V-2 | 18 |
| F cascades | 15 | 13 | 0 | 2 (F-1 into SEND-35, F-2 into SEND-36) | 11 |
| Verifier V-1..5 | 5 | 0 | 0 | 5 (all superseded by lane items) | |
| Bolt-on 1 tsc | 94 errors | 0 left | | | build green |
| Bolt-on 2 RLS | 12 tables | 2 gaps | 0 | | 10 tables OK |
| Bolt-on 3 boundaries | 0 files | 5 files added | | | tsc + eslint clean |

Cross-check: confirmed 13+17+15+11+17+13 = 86; superseded 1+0+0+1+1+2+5 = 10; refuted 2; total 98.

**Finished:** 2026-09-05 (see the commit timestamps; hard stop was 11:22Z, work completed before 09:40Z).
**Status:** COMPLETE. Fixes shipped locally on master (7 commits), nothing pushed, migration 00126 written and not applied.
