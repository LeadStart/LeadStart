---
name: tube-pipeline
description: Run a batch of law-firm prospects end to end, from Scrap.io to the live LeadStart campaign. It confirms the batch brief with the owner (area, practice areas, filters, budget, source, enrichment, who gets emailed, campaign, pace, flagged firms), pulls firms from Scrap.io, reviews them, imports and enriches them in LeadStart (owner names + verified emails), checks their integrity, scans them in TuBe SEO for AI visibility (the TuBe "enrichment"), validates TuBe's "Export for outreach" against every firm's own report, loads the sendable firms into the campaign with the fields its copy uses, renders every email to prove it reads right, and ends every run with a thorough completion assessment. Use it whenever the owner talks about a new batch, wave, market or cohort (WA-10, Oregon, California…), pulling firms from Scrap.io, sending leads to TuBe, scanning or re-scanning prospects, TuBe's export, importing TuBe results into the campaign, "the next batch", a batch's budget or area, or asks where a batch stands or how a run went (the assessment), even if they never say "pipeline".
---

# TuBe pipeline

The owner's words for this job: pull contacts from Scrap.io → review them here → enrich them → push them into TuBe for its AI-visibility scan (TuBe's "enrichment") → export → review again → upload the final list to the campaign, aligned with the contact list already there.

Everything below was learned running the first batches (Sept 2026). The scripts reuse LeadStart's own code wherever the app has it, so a batch comes out exactly as the app would build it. On top of that sit the checks that caught real mistakes before they reached a prospect.

## The steps

| # | Step | How | The owner's go? |
|---|---|---|---|
| 0 | **Brief**: confirm what we're looking for | `brief.mjs`, then the 10 questions | **yes**: the owner answers, every run |
| 1 | Pull firms from Scrap.io | `source-pull.mjs`: the plan, then `--count --go`, then `--pull --go` | **yes**: the searches, then the credits |
| 2 | Review the pull | `source-review.mts` | the owner looks at every dropped firm |
| 3 | Import + enrich in LeadStart (owner names, verified emails) | `source-import.mts`, `enrich.mts`, `enrich-watch.mjs`, `enrich-report.mts` | **yes**: the import, then the enrichment cost |
| 4 | Integrity check + TuBe upload sheet | `build-upload.mts` + `tube-check.js` in the TuBe page | no (read-only) |
| 5 | Upload + scan in TuBe | Claude in Chrome on the TuBe admin page | **yes**: the scan's cost (the upload itself is pre-approved) |
| 6 | Export + validate | Chrome download, then `validate-export.mjs` | no: the download is pre-approved |
| 7 | Load into the campaign | `import-campaign.mts`: dry run, then `--apply` | **yes**: enrolls real people in a live campaign |
| 8 | Verify | `verify-campaign.mts` | no |
| 9 | **Completion assessment** for the owner | `assess.mjs --run <name> --final` (and interim at every pause) | no: it's the report the owner asked for |

`status.mts` shows where any run stands, what it has spent against its budget, and the next step. `assess.mjs` is the full account (step 9).

When the firms are already in LeadStart and enriched (an in-app Apify search, a tag), skip steps 1–3 and start at step 4 with `--tag` or `--searches`. LeadStart's enrichment comes before TuBe on purpose. It's the big filter: on WA-10, 191 of 565 firms ended with a verified owner email. TuBe's scan leaves about 9 in 10 sendable, so TuBe only scans firms we can actually email.

## Ground rules

These are the owner's standing rules, and each one exists because something went wrong without it. Restate them with every brief.

- **Every go is for one batch and one step.** Ask with exact counts and cost. Approval for one step or batch never carries to the next.
- **Downloads and uploads between LeadStart and TuBe are pre-approved.** Owner, 2026-09-30: "downloading and uploading from leadstart and tuBe is acceptable". That covers the TuBe CSV upload, the TuBe "Export for outreach" zip, and moving files between the two apps. Don't ask for them; name the file in the report instead. Money (enrichment, scans) and enrolling people in a campaign still need the owner's go.
- **Run straight through.** Do each step as soon as the owner approves it. Never suggest holding a step for timing, e.g. "scan nearer the send date", and never tell the owner a step is "due" later. (Owner, 2026-09-30, after exactly that: "scan it now, why would you tell me when it's due?")
- **Exact counts, never "some".** Every line a batch will send must be true for every recipient.
- **Outside services.**
  - Ask before any bulk call to Scrap.io, Apify, DataForSEO or Million Verifier, even a free one, with the number of calls.
  - Stop on the first 403/429 and never read an error as zero. The scripts do this for you.
  - Size only the metros in the brief: sweeping whole states for "free" counts locked Scrap.io on 2026-09-26.
  - **Scrap.io searches have hard ceilings.** Every search (counts, pages, lookups) goes through `scrapio.mjs`, which logs it in LeadStart's shared search log before sending it. The log refuses past **150 in 24 hours, 400 in 7 days and 1,000 in 30 days**; the app and every computer share it. One script run sends at most 100. Never write a script that calls scrap.io directly or loops over a state's cities. If a job doesn't fit, narrow the metros or wait: raising a ceiling takes a new LeadStart migration and the owner's go.
- **TuBe asks Google only** (no ChatGPT, no branded question). Never re-scan a firm TuBe already scanned unless the owner asks.
- **The copy is the owner's.** The scripts fill values and never change wording. A held firm is never "fixed" by hand-editing its values: it goes back to the owner, or to a re-scan the owner approves.
- **Hot leads get the report link**, not the PDF.
- **Credentials stay inside the scripts**, and are never printed.
- **Changes to this skill stay local** until the owner says push (LeadStart `master` auto-deploys). When editing this file, never write a dollar sign followed by a digit: the skill loader reads it as an argument placeholder. Write "about six dollars" instead.

## Running the scripts

Run everything from the LeadStart repo root, so tsx can resolve the app's `@/` imports.
- `.mjs` files run with `node`.
- `.mts` files run with `npx tsx`.
- Steps 3a and 3b load the app's server code, so they add `--tsconfig scripts/tsconfig.harness.json`, which stubs `server-only`.

```bash
npx tsx .claude/skills/tube-pipeline/scripts/status.mts --run <name>
```

- Each batch gets a **run folder**: `~/Downloads/tube-pipeline/<run>/`. It's outside the repo because it holds prospect names and emails. `run.json` is the ledger every script stamps, and `brief.json` holds the owner's answers.
- Name runs by market and month, e.g. `wa10`, `or-metro-2026-10`.
- The TuBe steps use **Claude in Chrome**, because the owner's Chrome is signed in to TuBe and the in-app browser isn't. Never type a TuBe password. Load `references/tube-browser.md` before any TuBe page step.

## Step 0: the brief (every run, before anything else)

Run `node .claude/skills/tube-pipeline/scripts/brief.mjs --run <name>`. It prints the 10 questions, pre-filled with the most recent run's answers.
1. Ask the owner all 10 in **one** message. Show the last answers as the default so "same as last time" is one word, but make them see every question.
2. Write the answers to `<run>/brief.json`, with `confirmed_at`. The schema is in `references/brief.md`, along with why each question matters.

The questions:
1. **Area**: which state, which cities or metros; every qualifying firm, or a cap per metro?
2. **Practice areas**: which law types (groups A, B, C); do "lawyers"-only listings get the broad question?
3. **Firm filters**: minimum Google reviews, website, open; which firms to drop (large or national, nonprofit, public, second offices)?
4. **Budget**: the total for the batch after sourcing, and is it a hard stop?
5. **Source**: Scrap.io (credits left, expiry date, search lock) or Apify?
6. **Enrichment**: find owner names? Recover catch-all emails? Weak email hosts set aside or enriched?
7. **Who gets emailed**: named owner with a verified or published personal email only; which TuBe results to send?
8. **Campaign**: which one, and the same copy?
9. **Pace and timing**: start when, any deadline, add inboxes or raise the daily cap?
10. **Flagged firms**: hold for review, or skip?

Step 4 refuses to run without a confirmed brief, and every paid step compares its cost with the budget left. After each paid step, log what it really cost: `status.mts --run <name> --spend "<what>" --usd <amount>`. `enrich-report.mts` logs enrichment by itself.

## Step 1: pull firms from Scrap.io

```bash
node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name>                  # the plan: sends nothing
node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name> --count --go     # free counts, the brief's metros only
node .claude/skills/tube-pipeline/scripts/source-pull.mjs --run <name> --pull --go      # the paid pull, capped
```

- **The plan** prints the searches, the credit cap from the brief, and the search log: how many searches were used in the last 24 hours, 7 days and 30 days, and whether the counts and the pull fit. It sends nothing to Scrap.io.
- **Counting** costs no credits, but uses Scrap.io's fair-use search quota: one search per metro per practice group. Ask first, e.g. *"May I run 30 free count searches (10 metros × 3 groups)?"* Counts include firms we already have, and overlap between groups. It refuses up front if the whole count doesn't fit the ceilings.
- **The pull** needs `source.credits_cap` in the brief, and the counts (they give its page count). It stops at the credit cap, and at any per-metro cap. It costs about 1 credit per new firm; firms we already have come back free, but still fill page slots.
  - Ask first, e.g. *"May I pull up to 800 credits (9,320 left, they expire Oct 8), about 45 searches?"*
  - It refuses up front if its pages don't fit the ceilings. If a ceiling or a 403/429 stops it midway, it still writes what came in and exits with code 2.
  - It syncs our block list first. After every page it adds that page's firms and websites to the list, so no firm is paid for twice.
  - Raw pages go to `scrapio-raw.jsonl` as they arrive.
- `--go` means the owner approved exactly what the plan printed. Never pass it on your own.

## Step 2: review the pull

```bash
npx tsx .claude/skills/tube-pipeline/scripts/source-review.mts --run <name> [--keep <id|website,...>] [--drop <id|website,...>]
```

It applies the owner's pre-enrichment rules:
- closed;
- public body, nonprofit, legal aid or referral service (by category or name);
- not a law practice;
- large or national firm (a name on the list, or 40+ emails on its site);
- already in LeadStart (same Google listing or same website);
- second office of a firm in this pull (the most-reviewed listing is kept).

It prints every judgment call by name. **Show the owner the public/nonprofit, not-a-law-firm and large-firm lists**, and re-run with `--keep` or `--drop` for anything they overrule. On WA-10 it dropped 17 non-law listings (accountants, realtors, mediators), 13 public bodies (prosecutors, public defenders, legal aid) and Miller Nash (large).

## Step 3: import and enrich in LeadStart

```bash
npx tsx --tsconfig scripts/tsconfig.harness.json .claude/skills/tube-pipeline/scripts/source-import.mts --run <name> [--apply]
npx tsx --tsconfig scripts/tsconfig.harness.json .claude/skills/tube-pipeline/scripts/enrich.mts --run <name> [--apply]
node .claude/skills/tube-pipeline/scripts/enrich-watch.mjs --run <name> [--follow]
npx tsx .claude/skills/tube-pipeline/scripts/enrich-report.mts --run <name>
```

- **3a `source-import`** (dry run, then `--apply` with the owner's go).
  - It creates a Maps search row holding the firms, the brief's filters, the credits and every exclusion.
  - It then runs the app's own `importMapsPlaces`, which:
    - stamps each firm's email host;
    - sets weak email hosts aside;
    - skips firms already in LeadStart.
  - Contacts are tagged `scrap.io` and `tube-<run>`. The run's cohort becomes that search.
  - The import itself costs nothing.
- **3b `enrich`** (dry run, then `--apply` with the owner's go on the cost).
  - It starts the app's own enrichment with the brief's add-ons: owner names on, email checks on, catch-all recovery per the brief.
  - Weak email hosts stay set aside unless the brief says enrich them.
  - The dry run states the estimate (WA-10 cost about 1.7 cents a firm) against the budget left. A hard-stop budget refuses an over-budget run.
- **3c `enrich-watch`** prints one status line. Use `--follow` in the background: it reports phase changes, and exits on trouble or 45 minutes without progress. Enrichment takes about 2–3 hours for 300 firms.
- **3d `enrich-report`** runs once enrichment is done. It reports:
  - named %, verified-email %, TuBe-ready count;
  - the full cost: cost_usd plus Perplexity's per-call fee.

  It then logs the spend and points to step 4. Tell the owner the yield and cost per TuBe-ready firm. WA-10's wave 1: 43% verified personal email, 113 TuBe-ready, 5.40 dollars.

## Step 4: integrity check + TuBe upload sheet

```bash
npx tsx .claude/skills/tube-pipeline/scripts/build-upload.mts --run <name>                         # after step 3: the cohort is set
npx tsx .claude/skills/tube-pipeline/scripts/build-upload.mts --run <name> --tag <tag>             # leads already in LeadStart
```

1. It runs **`buildTubeHandoff`, the in-app "TuBe upload" code**: ICP exclusions, a verified or published owner email, the owner's first name, the city lock, and the exact question.
2. It then **drops** anyone who would be contacted wrongly:
   - already in the campaign, or the same firm (website or non-Gmail email domain) already in it;
   - active in another campaign;
   - already emailed;
   - on the do-not-contact list;
   - another client's;
   - bounced, unsubscribed or replied;
   - undeliverable;
   - pooled as a weak email host.
3. It **flags** rows for a human look:
   - a keyword-style or ALL-CAPS listing name;
   - an address that looks like someone other than the owner;
   - an odd first name;
   - an email on another firm's domain;
   - a published catch-all address.
4. Run the generated `tube-check.js` on the TuBe admin page (`references/tube-browser.md` §2). Save its one line **verbatim** as `<run>/tube-scanned.json`, and re-run. It writes:
   - `sheet.csv`;
   - `tube-upload-<run>.csv`, only the firms TuBe hasn't scanned;
   - `upload-report.json`.

Read the flags to the owner by name.

## Step 5: upload + scan in TuBe (owner's go on the cost)

Skip this step when the upload file has 0 rows. Otherwise ask about the money only (the upload is pre-approved), e.g.: *"Ready to scan 186 new firms in TuBe (cold scan, Google only). TuBe estimates about six dollars; the last WA batch cost about half its estimate. Go?"*

Then follow `references/tube-browser.md` §3:
1. Upload the file.
2. Check that "Run N from CSV" matches, depth is Cold touch, and the ChatGPT and branded boxes are off.
3. Press Run.
4. Record it: `status.mts --run <name> --mark scan --note "<N> firms, TuBe est. X"`.

Re-run `tube-check.js` every few minutes (`open` → 0); a 190-firm batch took about 45 minutes. Unfinished rows: §4. Re-running them costs money, so ask. Never press Stop through Chrome, because its confirm dialog freezes the extension. When `open` is 0, save the check again and re-run `build-upload.mts`. Log the actual cost with `--spend`.

## Step 6: export + validate (download pre-approved)

As soon as the scan finishes, click "Export for outreach" on the run's batch (§5). It downloads one zip from tube-seo.vercel.app to Downloads, named after the uploaded file, e.g. `tube-upload-wa10-outreach.zip` (about 100 KB). The owner pre-approved this download, so don't ask; name the file in the report.

```bash
node .claude/skills/tube-pipeline/scripts/validate-export.mjs --run <name> --zip "C:/Users/dtucc/Downloads/<file>-outreach.zip"
```

It checks every **send** row three ways, and holds any row with a problem:
- **Against our sheet:** same email, first name, city and question.
- **Against the export contract:**
  - a sendable segment;
  - a real competitor (not a directory, not the firm itself);
  - display-clean names (no PLLC, ALL CAPS, taglines, keyword-style names or job titles);
  - an address that belongs to the person greeted;
  - 0–100 scores;
  - a report link;
  - a rank for "named but not first".
- **Against the firm's own report page:**
  - the question asked;
  - the verdict;
  - the AI's first pick = `competitor_1`;
  - a missed self-mention;
  - both scores Email 2 quotes.

  One GET per row, cached. A 190-row batch takes about 2½ minutes.

It writes `send-validated.csv` (the only rows step 7 imports), `held.csv` with reasons, and `validation.json`. Report the held firms and TuBe's own review list by name, with exact counts. The report page shows only about 520 characters of Google's answer, and TuBe's export check reads the stored 3,000: that's why both exist.

## Step 7: load into the campaign (owner's go)

```bash
npx tsx .claude/skills/tube-pipeline/scripts/import-campaign.mts --run <name> [--exclude <domain,...>]   # dry run
npx tsx .claude/skills/tube-pipeline/scripts/import-campaign.mts --run <name> [--exclude <domain,...>] --apply
```

It works like the campaign's own CSV import for an owner:
1. Match each row to its LeadStart contact by email.
2. Adopt it into the campaign's client (or link it if it's already the client's).
3. Merge the 12 TuBe values into `custom_fields` (`references/field-contract.md`).
4. Enroll it at Email 1.
5. Register the columns.

It re-checks the drop rules against live data. It then **renders every email for every planned contact** exactly as the live sender will, and any problem refuses `--apply`.

The dry run prints the plan, the skips, the render check, a rough pace and one sample Email 1. Ask, e.g.: *"Ready to enroll 152 firms in 'TuBe SEO — AI Visibility Launch' (active). 79 are already waiting at Email 1; it starts at most 20 new people a day, so these start over the next ~2½ weeks. All 456 emails render cleanly; sample below. Go?"*

`--apply` backs up every touched contact, writes, reads everything back, and saves `import-result.json`.

## Step 8: verify

`verify-campaign.mts --run <name>` renders every email for the run's imported contacts, as they will send. It also re-checks that each is still enrolled, on the right client, not on the do-not-contact list, and not pooled. Without `--run`, it checks the whole campaign; run that after the owner edits copy.

## Step 9: completion assessment (every run)

The owner asked for this on 2026-09-29: "give me a thorough completion assessment when it's done as part of the skill". A run isn't finished until the owner has it.

```bash
node .claude/skills/tube-pipeline/scripts/assess.mjs --run <name>           # interim: where it stands now
node .claude/skills/tube-pipeline/scripts/assess.mjs --run <name> --final   # at the end of the run
```

It writes `<run>/assessment.md` and prints the same report. It reads the run's files and the live database, and changes nothing but the ledger. The report has nine sections:
1. **Verdict:** the status (in progress, stopped, complete, complete with problems), the firms at each step, the money, and the next step with its gate.
2. **The brief against the outcome:** area, filters, budget, credits, searches, enrichment, who gets emailed, campaign, pace and flagged firms, each marked ✓ or ✗.
3. **Every firm, step by step:** in and out at each step, where every lost firm went and why, and the pull by metro.
4. **Money and Scrap.io usage:** each spend, total against the budget, a projection for the paid steps still ahead, credits, searches against the ceilings, and the cost per pulled firm and per enrolled lead.
5. **Quality checks:** each check that ran, with its result.
6. **Held or open, by name:** review drops, weak hosts set aside, sheet drops, flags, TuBe failures, validation holds, import skips and verify problems. Each comes with what it needs.
7. **Timing:** the campaign's queue, and when this run's firms start getting emails.
8. **Incidents and deviations** from the brief. New ones go in `references/lessons.md`.
9. **A comparison** with the last finished run.

When to run it:
- **At every pause:** give the owner the interim assessment whenever a run stops for more than a day, for example while it waits for the owner's go.
- **At the end:** after step 8, run it with `--final`. Give the owner the verdict, the held list and the timing in the chat, and point to `assessment.md` for the rest.
- `--final` on an unfinished run saves an interim assessment and says what's missing.

## After the import

- The campaign sends within its window and caps; there's nothing to press.
- A "send it" reply is a hot lead: the classifier alerts hello@saasassinsdev.com.
- Answer a hot lead with the **link** to its existing report (`report_link`; the link never expires), not the PDF.
  - The admin inbox's reply box offers **Insert link**.
  - The campaign's saved reply (Setup tab; migration 00134) opens with the link filled in.
  - A re-scan would get fresh answers that can contradict the emails.
- Firms with no PDF (`nopdf` in step 4) have working links.

## Reporting to the owner

After each step, in plain words and exact counts:
1. What happened.
2. What's held, by name, with each reason, and what you need from the owner.
3. Spent so far against the budget.
4. The next step, with its gate.

At every pause and at the end, the report is the completion assessment (step 9).

## When something goes wrong

- **Scrap.io answers 403/429.** The script stops by itself, and nothing is retried. A "fair-use" 403 means the account is locked until Scrap.io support unlocks it. Tell the owner, and don't try again.
- **"REFUSED … search limit".** The shared search log is full for one of its windows. That's the guard working. Report the numbers it printed, and offer fewer metros or a later start. Never work around it.
- **Enrichment stalls or errors** (`enrich-watch --follow` exits 3 or 4). Report the phase and message. The app's enrichment cron owns retries.
- **Scans sit at "Running".** The TuBe worker clears rows stuck for over 30 minutes. `references/tube-browser.md` §4 shows its live commit and open jobs. Render auto-deploys the worker on every push to TuBe `master`, and only Michael has Render access.
- **The batch isn't on TuBe's admin page.** It lists only the 5 newest batches and newest 500 scans, so export soon after each scan finishes.
- **The export is missing columns.** TuBe changed its export. Update `references/field-contract.md` and the scripts' column lists together; never guess.
- **Claude in Chrome isn't connected.** Say so and wait. Don't switch to the in-app browser.
- **A render problem at step 7** means a value is blank or malformed. Hold those firms with `--exclude` and report. Never patch copy to hide it.

## References

- `references/brief.md`: the 10 questions, why each matters, their defaults, and the brief.json schema.
- `references/tube-browser.md`: every TuBe admin-page step, with tested snippets, and the page's limits.
- `references/field-contract.md`: the upload and export columns, the segments, how each lands in LeadStart, and the import's skip rules.
- `references/lessons.md`: what went wrong on earlier batches, and which check now catches it. Read it before changing any check.
