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

## 3. Configure LeadStart

1. **Settings → Integrations → Native Email (Google).** Paste the service
   account **email** and **private key** (the `private_key` field, including
   the `BEGIN/END` lines). Save.
2. **Sending → Mailboxes → Add a mailbox.** Enter a sending address on an
   authorized domain. LeadStart calls the Gmail profile API to confirm
   delegation works before saving; a mis-authorized domain fails here with a
   clear error.
3. Click the **Send** (test) button on the new row. A test email is sent from
   the inbox to itself — check it arrived with the right From line. That
   proves the whole JWT → token → send path end-to-end.

## Notes

- **One service account serves every domain** that authorizes its client ID.
  You only repeat step 2 per new domain, never step 1.
- **The private key can impersonate any mailbox on an authorized domain.**
  Treat it like any other production credential; it lives in the same
  org-settings trust boundary as the Salesforge/Unipile keys.
- **Ramp & caps** are per-mailbox data (see `src/lib/gmail/ramp.ts`): new
  inboxes start at 5/day and step up weekly to the mailbox's cap (default 20).
  Send window is Mon–Fri, 8am–5pm Eastern. Adjust caps per mailbox on the
  Mailboxes page.
- **No warmup product and no tracking.** New inboxes just ramp slowly; metrics
  are sent / bounced / replied only (no open pixel, no link rewriting).
- If a domain later revokes delegation, the affected mailbox flips to
  **Error** with the reason on the Mailboxes page; re-authorize in Admin and
  resume it.
