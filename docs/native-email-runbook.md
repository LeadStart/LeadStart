# Native email channel — Google Workspace setup runbook

LeadStart can send cold email directly from client-owned Google Workspace
inboxes (no Salesforge), rotating across a pool and pacing per inbox. It
connects with **one Google service account using domain-wide delegation
(DWD)** — the service account impersonates each mailbox. This avoids the
public OAuth consent flow entirely (no Google verification/CASA, no per-user
consent screens, no 7-day token expiry).

Do this once per Google Cloud project, then once per **sending domain**.

## 1. Create the service account (once)

1. In [Google Cloud Console](https://console.cloud.google.com), create (or pick)
   a project.
2. **APIs & Services → Library → Gmail API → Enable.**
3. **APIs & Services → Credentials → Create credentials → Service account.**
   Name it e.g. `leadstart-native-sender`. No project roles are needed.
4. Open the service account → **Keys → Add key → Create new key → JSON.**
   Download the JSON. You need two fields from it:
   - `client_email` → the service account email
     (`…@….iam.gserviceaccount.com`)
   - `private_key` → the PEM block (`-----BEGIN PRIVATE KEY-----…`)
5. On the service account's **Details** page, copy its **Unique ID** (a long
   number, the "OAuth 2 client ID"). You'll need it in step 2.

## 2. Authorize the service account per sending domain (once per domain)

In the Google **Admin** console for each Workspace domain whose inboxes will
send:

1. **Security → Access and data control → API controls → Domain-wide
   delegation → Manage domain-wide delegation → Add new.**
2. **Client ID** = the service account's Unique ID from step 1.5.
3. **OAuth scopes** (comma-separated, exactly):
   ```
   https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly
   ```
4. Authorize. Propagation is usually immediate but can take a few minutes.

> `gmail.send` sends; `gmail.readonly` lets the reply poller read inbound
> mail (replies + bounces). No `gmail.modify` — LeadStart never mutates the
> mailbox.

### 2a. Extra scopes for automated domain + inbox provisioning (Phase 3)

To let LeadStart buy/track a domain and create its Workspace inboxes for you
(Admin → Mailboxes → Provision a domain), the **same** service-account client ID
needs four more scopes, and its Cloud project needs three APIs enabled.

**Editing a client ID's scope list REPLACES it** — so paste ALL SIX at once, not
just the new four:

```
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/admin.directory.domain
https://www.googleapis.com/auth/admin.directory.user
https://www.googleapis.com/auth/siteverification
https://www.googleapis.com/auth/apps.licensing
```

Then, in the **Google Cloud console** for the service account's project, enable:
**Admin SDK API**, **Site Verification API**, and **Enterprise License Manager API**.

Finally, in **Settings → Integrations**, set **Google admin email** to a Workspace
super-admin. Unlike sending (which impersonates each mailbox), the Directory /
Site Verification / Licensing APIs impersonate an admin. If your tenant does NOT
auto-license new users, also set the license product/SKU (otherwise the licensing
step is skipped, which is correct for auto-licensing tenants). DKIM stays a manual
one-click generate in the Admin console per domain; LeadStart detects it and
advances the domain to warming automatically.

## 3. Configure LeadStart

1. **Settings → Integrations → Native Email (Google).** Paste the service
   account **email** and **private key** (the `private_key` field, including
   the `BEGIN/END` lines). Save.
2. **Sending → Mailboxes → Add a mailbox.** Enter a sending address on an
   authorized domain. LeadStart calls the Gmail profile API to confirm
   delegation works before saving; a mis-authorized domain fails here with a
   clear error.
3. Click the **Send** (test) button on the new row, enter a recipient (it
   defaults to your login email — a personal Gmail is ideal), and send. The
   message is a short, plain, link-free note signed by the mailbox — the same
   neutral probe the placement test uses — so besides proving the whole
   JWT → token → send path end-to-end it gives you a quick manual placement
   read: open that inbox and see whether it arrived in **Inbox**,
   **Promotions**, or **Spam**. (A self-send is refused: mail to itself never
   leaves the tenant and always lands in the inbox, so it proves nothing.)

## 4. Seed inboxes + placement tests (where mail actually lands)

Every other health signal (DNS, blacklist, bounce rate, the zero-reply proxy)
is an *inference*. A **placement test** measures placement directly: it sends
one probe from a sending mailbox to each **seed inbox** on a different domain,
waits a minute, then reads each seed through the Gmail API (the same
`gmail.readonly` delegation) to see which folder the probe landed in — Inbox,
Promotions, or Spam — and what the receiver's `Authentication-Results` header
says about SPF/DKIM/DMARC *as delivered*. That last part is what turns "the
score dipped" into "why": an auth failure at the receiver is a DNS/DKIM fix;
auth passing with a spam verdict is reputation or copy.

1. **Sending → Mailboxes → Seed inboxes.** The quickest panel is
   **Use sending mailboxes as seeds**: every registered mailbox is already
   delegation-verified, and any two on different domains can probe each
   other (three client domains = a 2–4-seed panel per mailbox with zero new
   setup). Or add a dedicated Workspace inbox on any authorized domain; it is
   verified with the Gmail profile API before saving. Seeds on a mailbox's
   own domain are skipped for that mailbox — same-tenant delivery is never
   filtered.
2. Click the **flask** button on a mailbox row (neutral probe), or expand the
   row and choose **Run with campaign copy** to probe with step 1 of the
   campaign the mailbox sends for (sample merge values). Run both and compare:
   neutral lands but campaign copy doesn't → the copy trips the filter; both
   go to spam → the domain/mailbox has a reputation problem.
3. Results appear inline within about a minute (the page polls; a
   `run-placement-tests` cron finishes anything left open and enforces the
   30-minute "missing" timeout). The latest result shows in the **Placement**
   column and feeds the **Seed placement** health signal (spam at ≥50% of
   seeds −45, any spam −25, any missing −10, Promotions majority −5; a result
   older than 7 days reads as unchecked).
4. **Settings → Integrations → Inbox health → Automatic placement tests.**
   Default 7: every active mailbox gets a fresh neutral probe weekly without
   clicks. Blank = manual only.

Probe sends are not campaign sends: they are never written to `native_sends`,
so they don't move the ramp, the daily counter, the bounce rate or the reply
denominator. Seeds are read-only — nothing is ever marked "not spam" or moved
(there is no `gmail.modify` scope, by design). Probe mail accumulates in seed
inboxes at roughly one message per sending mailbox per week; archive it
whenever convenient.

> Scope today: Google Workspace seeds only (read via DWD). Microsoft 365 /
> Yahoo seeds would need their own readers (Graph OAuth / IMAP app passwords);
> the `seed_inboxes.provider` column reserves room for them.

## 5. Pre-send email verification (Million Verifier)

Every recipient is verified **just before its first send** (migration `00069`).
The gate lives inside `run-native-sequences` as the last check before the Gmail
API call, so a credit is only ever spent on an address that would otherwise be
sent to right now. Results are cached on the contact for **30 days**, so
follow-up steps to an already-verified address are free.

**Setup:** paste a Million Verifier key on **Admin → Integrations → Email
verification** and click **Test connection** (shows the remaining credit
balance). Leaving the key blank **disarms** the gate — sends proceed unverified,
exactly as before this feature. Get a key at `app.millionverifier.com/api`
(pay-as-you-go, ~$37/10k, credits never expire).

**What each result does:**

| Result | Action | Charged? |
|--------|--------|----------|
| `ok` | send | yes |
| `catch_all` | **send, flagged risky** (can't confirm/deny; bounce monitoring + inbox-health auto-pause catch any damage) | no |
| `unknown` | hold + retry (free) up to 3× at 1h apart, then send flagged risky | no |
| `invalid` | **skip** — enrollment failed, contact flagged; never sent | yes |
| `disposable` | **skip** | yes |
| `error` (per-address) | hold + retry up to 5× at 1h apart, then skip | no |

`role` (info@/sales@) and `free` (gmail.com) are stored as flags only and never
change the send decision — they're a targeting call, not a deliverability one.

**Fail-closed on outage.** If the verifier is unreachable, out of credits, or the
key is rejected, new first-touch sends to *unverified* addresses **hold** (they
retry on later ticks) rather than going out unverified — contacts with a fresh
cached result still send. A definitive error (bad key / no credits / IP blocked)
stops all calls for **1 hour** and fires an `email_verifier_unavailable` owner
alert; a low balance (< 500 credits) fires `email_verifier_credits_low` once as
it crosses. Fix the key / top up on the Integrations page — the Save/Test button
clears the error state so the next tick retries immediately.

**One-time rollout burn.** On first deploy, every active/queued contact without a
cached result verifies at its next step — budget roughly one credit per such
contact (catch-all/unknown are free). Check the balance before deploying.

**Reading a tick.** The `run-native-sequences` JSON response carries a
`verification` array (one entry per org): `mode` (`armed`/`suppressed`/`tripped`/
`disarmed`), `calls`, `cached`, `held`, `skipped`, `credits`, and a per-result
`counts` map. Result codes in the `results` array: `verify_hold_*` (backoff /
budget / verifier down), `verify_skip_invalid|disposable|error`.

**Validating the policy.** The send row records what the gate saw
(`native_sends.email_verification_result`). To check whether "send catch-all,
flag risky" is holding up, slice bounces by result:

```sql
select email_verification_result, status, count(*)
from native_sends
where sent_at > now() - interval '7 days'
group by 1, 2 order by 1, 2;
```

If catch-all rows bounce materially more than `ok` rows, revisit the policy.

## Notes

- **One service account serves every domain** that authorizes its client ID.
  You only repeat step 2 per new domain, never step 1.
- **The private key can impersonate any mailbox on an authorized domain.**
  Treat it like any other production credential; it lives in the same
  org-settings trust boundary as the Salesforge/Unipile keys.
- **Ramp & caps** are per-mailbox data (see `src/lib/gmail/ramp.ts`): new
  inboxes start at 5/day and gain +1/day as they actually send (5, 6, 7 ...)
  up to the mailbox's cap (default 20, the hard ceiling). The ramp is keyed to
  the cumulative send count, so a paused inbox holds its place rather than
  fast-forwarding.
  Send window is Mon–Fri, 8am–5pm Eastern. Adjust caps per mailbox on the
  Mailboxes page.
- **No warmup product and no tracking.** New inboxes just ramp slowly; metrics
  are sent / bounced / replied only (no open pixel, no link rewriting).
- If a domain later revokes delegation, the affected mailbox flips to
  **Error** with the reason on the Mailboxes page; re-authorize in Admin and
  resume it.
