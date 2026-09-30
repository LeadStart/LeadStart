# The batch brief: what we're looking for, confirmed every time

Every run starts here, before any pull, scan or import.
1. Ask the owner these 10 questions in **one** message, each pre-filled with the previous run's answer. `brief.mjs --run <name>` prints them with that run's answers.
2. Save the answers as `<run>/brief.json`.
3. Every later stage checks against the brief: the area it pulls, the filters, the budget cap, the campaign it fills.
4. The owner may answer "same as last time" to any question, but must see each one.

Why: every batch so far has turned on these choices, and the ones decided in chat were easy to lose. The WA-10 area and filters, the West Coast budget, and "Google only" were all decided that way. The Scrap.io lock came from sizing markets nobody had asked for.

## The 10 questions

| # | Ask | Default (last decided) | What it drives |
|---|---|---|---|
| 1 | **Area:** which state, and which cities or metros? Every qualifying firm in each city, or a cap per metro? | WA-10: the 10 largest WA cities, every qualifying firm. West Coast plan: Oregon's urban core first, then CA metros with caps. | What gets pulled. Count only these metros: sizing whole states locked Scrap.io on 2026-09-26. Capped pulls follow Scrap.io's own order, not Google's ranking. |
| 2 | **Practice areas:** which law types? And should "lawyers"-only listings get the broad "best lawyers in X" question? | 15 types. **A:** attorney, law firm, personal injury, family law, criminal defense. **B:** estate planning, divorce, real estate, bankruptcy, immigration. **C:** elder law, employment, SSDI, insurance, medical malpractice. "Lawyers"-only listings: **left out**. | Scrap.io categories; `--include-generic` in step 4. |
| 3 | **Firm filters:** minimum Google reviews; website; open; which firms to drop. | 10+ reviews, has a website, open. Drop large or national firms, nonprofits, public bodies, and second offices of a firm we have. Solo attorneys are in. | The pull filters and the pre-enrichment review. |
| 4 | **Budget:** the total for this batch, and whether it's a hard stop. | West Coast plan: about 60 dollars after sourcing (enrichment + email checks + TuBe scans), a hard stop. | Every paid step states the spend so far against this cap before asking the owner to go. |
| 5 | **Source:** Scrap.io or Apify? | Scrap.io while prepaid credits last. Check the credits left, their expiry date (2026-10-08), whether searches are locked, and the room left in the search log (`source-pull.mjs` prints it). Apify takes only Google's top 50 per city, and every place costs. | Which pull runs, and at what cost. |
| 6 | **Enrichment options:** find owner names? Recover catch-all emails (Findymail)? Weak email hosts: set aside or enrich too? | Owner names **on**; catch-all recovery **off**; weak hosts **set aside** (only about 1 in 5 becomes sendable). | LeadStart enrichment settings for the run. |
| 7 | **Who gets emailed:** which contacts, and which TuBe results? | Only a named owner with a verified personal email, or their own address published on the firm's site. Generic inboxes go to review. Send "not named" and "named but not first"; skip "named first". | Step 4 and step 6 rules. |
| 8 | **Campaign:** which one, and the same copy? | "TuBe SEO — AI Visibility Launch". Same copy: Email 1 quotes each firm's own question, so it reads right in any state. | Step 7's target. The copy stays the owner's. |
| 9 | **Pace and timing:** when should they start? Any deadline? Add inboxes or raise the daily cap? | The campaign starts at most 20 new people a weekday, and its 3 inboxes send about 21 emails a day (growing as they warm). N new firms take about N ÷ 20 weekdays. | Whether a batch needs more inboxes first. Also any deadline, like credits expiring. |
| 10 | **Flagged firms:** hold them for review, or skip outright? | **Hold for review:** wrong-person addresses, keyword-style names, titles like "…, Attorney", national firms. | What step 6 and 4 do with held rows. |

## Standing rules: shown with the brief, not asked

These are the owner's standing rules; restate them so they're in front of everyone each run:
- TuBe scans ask **Google only**: no ChatGPT, no branded question (the cheapest).
- **Never re-scan** a firm TuBe already scanned, unless the owner asks.
- **Ask before any bulk call** to an outside service, even a free one, with the rough call count. Stop on the first 403/429.
- The copy is the owner's. The pipeline fills values and never edits wording.
- **Hot leads get the report link**, not the PDF (a PDF reply landed in spam).
- **Exact counts, never "some".**

## brief.json

```json
{
  "run": "wa10",
  "confirmed_at": "2026-09-25T00:00:00Z",
  "area": { "state": "WA", "metros": ["Seattle", "Tacoma", "..."], "caps": {}, "exhaustive": true },
  "practice": { "groups": ["A", "B", "C"], "include_generic": false },
  "filters": { "min_reviews": 10, "website": true, "open_only": true, "drop": ["large", "nonprofit", "public", "second_office"], "solos": true },
  "budget": { "total_usd": null, "hard_stop": true, "notes": "" },
  "source": { "kind": "scrapio", "credits_cap": 700 },
  "enrichment": { "naming": true, "catch_all_recovery": false, "weak_hosts": "set_aside" },
  "who": { "personal_email_only": true, "segments": ["NOT_NAMED", "NAMED_NOT_FIRST"] },
  "campaign": { "id": "a23526b3-1858-40b1-9726-3d8a5c952644", "name": "TuBe SEO — AI Visibility Launch" },
  "pace": { "start": "asap", "deadline": null, "notes": "" },
  "flagged": "hold",
  "notes": ""
}
```

- `confirmed_at` is set only after the owner has seen every question.
- `build-upload.mts` refuses a run without a confirmed brief, reads `practice.include_generic` and `campaign.id` from it, and prints the budget left against the scan estimate.
- Record every actual spend in the ledger with `status.mts --run <name> --spend "<what>" --usd <amount>`. `status.mts` then shows spent vs. budget.
