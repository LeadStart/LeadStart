# Hosting LeadStart locally vs. Vercel + Supabase

> Task #228 from LeadStart App's queue (2026-10-26). A written comparison only: nothing in the
> hosting setup was changed. Every number below is either measured (says how) or quoted from the
> provider's own page (linked). "Not stated" means the page didn't say.

## The short answer

- **Vercel: moving LeadStart off it saves nothing on its own.** The LeadStart Vercel team is one
  Pro plan ($20 a month) that hosts six projects. LeadStart's own usage for the last 30 days came to
  $4.55, all of it inside the plan's $20 credit. The $20 stops only if all six projects leave
  that team, and LeadStart can't use the free Hobby plan (its crons run every minute; Hobby allows
  once a day, and Hobby is for non-commercial use).
- **Supabase: $25 a month is the only real saving**, by moving the database to Supabase's Free plan
  or onto this Mac. Free loses the daily backups and the dedicated compute (the 2026-08-23 outage
  happened on Free), and the Mac would put sign-in, the data and its backups on one laptop.
- **Claude's read:** the most any of this saves is $45 a month, and only if the five other Vercel
  projects move too. Each saving moves a client-facing system that sends email onto a laptop or onto
  a tier that has already failed once. At today's numbers the setup is already near the floor of
  what these two services cost.

## What LeadStart pays and uses today (measured)

| What | Number | How it was measured |
|---|---|---|
| Vercel team | `leadstarts-projects`, **Pro** | Vercel API `GET /v2/teams`, 2026-10-26 |
| Projects on that team | 6: `leadstart`, `saasassins-crm`, `website`, `saasassins`, `mayster-demo`, `shell-build` | Vercel API `GET /v9/projects` |
| Vercel plan charge, last 30 days | $19.91 | Vercel billing charges API (`/v1/billing/charges`, 2026-09-26 to 2026-10-26), "Pro" line |
| Vercel usage, last 30 days, whole team | $4.68 at list price, of which $0.12 was billed beyond the $20 credit | same; `EffectiveCost` vs. `BilledCost` |
| Vercel usage, LeadStart project only | $4.55 (Observability events $2.71 is the biggest line, then function memory and CPU) | same, grouped by the `ProjectName` tag |
| Other five projects' usage | $0.20 together | same |
| Function invocations, whole team, 30 days | 653,257 | same |
| Supabase plan | **Pro** ($25 a month), Micro compute, which the plan's $10 compute credit covers | Supabase project settings, read during planning |
| Database size | 66 MB | `pg_database_size`, read-only |
| Data | 12,657 contacts, 4,134 sends, 6 sign-in users, 0 stored files | read-only counts |
| Supabase features in use | Postgres and Auth only: no Storage files, no Realtime, no Edge Functions, no `pg_cron` | read-only catalog checks |
| Crons in `vercel.json` | 21: 6 every minute, 1 every 2 minutes, 3 every 5, 2 every 10, 1 every 15, 4 hourly, 1 every 6 hours, 3 daily | `vercel.json` |
| Inbound webhooks | Stripe, Resend, Unipile (`src/app/api/webhooks/`) | code |
| This Mac | MacBook (Mac17,4, a laptop with a battery), 16 GB RAM, runs Forge; no Docker, no `cloudflared` | `sysctl`, `pmset`, `which`, during planning |

The Supabase bill itself (any usage beyond the plan) was not read: no billing API call was made for
Supabase. The Supabase dashboard's Usage page shows it.

## What the providers say

**Vercel** ([Cron Jobs: usage and pricing](https://vercel.com/docs/cron-jobs/usage-and-pricing)):

> Hobby accounts are limited to cron jobs that run **once per day**. Cron expressions that would run
> more frequently will fail during deployment.

The same page gives Pro a minimum interval of "Once per minute".

**Vercel** ([Hobby plan](https://vercel.com/docs/plans/hobby)):

> As stated in the fair use guidelines, the Hobby plan restricts users to non-commercial, personal use
> only.

**Vercel** ([Pricing](https://vercel.com/pricing)): Pro is "$20/mo." and "Pro plans have a $20
included credit to use across resources." Hobby is "$0/mo."

**Supabase** ([Pricing](https://supabase.com/pricing)):

- Free: "500 MB database size (Shared CPU • 500 MB RAM)", "Limit of 2 active projects.", "Free
  projects are paused after 1 week of inactivity.", automatic backups "Not included."
- Pro: "from $25/month", "Pro and Team plans include $10/month in compute credits", "Daily backups
  stored for 7 days".

**Supabase** ([Backups](https://supabase.com/docs/guides/platform/backups)):

> We recommend that free tier plan projects regularly export their data using the Supabase CLI
> `db dump` command

and that they "maintain off-site backups".

**Supabase** ([Self-hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker)):
minimum "4 GB" RAM, "2 cores", "40 GB SSD"; recommended "8 GB+", "4 cores+", "80 GB+ SSD". Who keeps
a self-hosted install backed up and patched: not stated.

**Cloudflare Tunnel** ([docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)):
"Cloudflare Tunnel uses an outbound-only connection model", so a machine can serve the internet
"without a publicly routable IP address". Its price: not stated on the pages read.

## The options, and how each would work day to day

### 1. The app on this Mac, Supabase kept

- **How it works:** the Mac runs `next start` all the time. A `launchd` job calls the 21 cron routes on
  their schedules (the job Vercel Cron does now). A Cloudflare Tunnel gives the app a public address,
  so clients, the quote and welcome pages, the website chat (Pan Pal) and the Stripe, Resend and
  Unipile webhooks can reach it. Deploying becomes "pull and restart on the Mac" instead of "push to
  master".
- **Saves:** $0 while the other five projects stay on the Vercel team. $20 a month only if all six
  leave it.
- **Risks:** whenever the Mac sleeps, travels, loses Wi-Fi, restarts for an update or runs out of
  memory beside Forge, sending stops, replies stop being read, and the client portal, quote pages and
  site chat go offline. The app would also share the Mac's 16 GB with Forge and its builds.

### 2. The database on this Mac too

- **How it works:** Supabase's Docker setup (Postgres, Auth, the REST API) runs on the Mac beside the
  app. The data moves over with a `pg_dump` and restore, and every client's sign-in moves with it.
- **Saves:** a further $25 a month.
- **Risks:** Docker isn't installed. The self-host minimum is 4 GB RAM and 2 cores before the app or
  Forge. Backups become a job someone has to run and test, and a lost or broken laptop takes the data
  with it unless they're kept off the Mac. Security updates for every Supabase part are also on us.

### 3. Supabase back to Free, nothing local

- **How it works:** the project drops to the Free plan; nothing else changes.
- **Saves:** $25 a month.
- **What it loses:** daily backups (Supabase recommends Free projects export their own), dedicated
  compute ("Shared CPU • 500 MB RAM"), and it counts against "Limit of 2 active projects". The data
  (66 MB) fits under 500 MB, and the every-minute crons keep it from pausing. The 2026-08-23 outage
  that lasted hours happened while the project was on Free.

### 4. Vercel Hobby

- **Not possible:** 18 of the 21 crons run more than once a day, and Vercel says such expressions "will
  fail during deployment" on Hobby. Hobby is also "non-commercial, personal use only".

## Not measured

- Supabase's own bill beyond the $25 plan (no billing read for Supabase).
- Whether the other five Vercel projects could move off the team; that's outside this repo.
- Cloudflare Tunnel's price (not stated on the pages read).
