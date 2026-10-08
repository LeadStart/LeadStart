---
name: reference_tube_repo_scan_engine
description: "Where the TuBe SEO repo + its AI-visibility prospect scanner live, what the cold scan does/costs, and its LeadStart \"Export for outreach\" contract (verified 2026-09-25)"
metadata:
  node_type: memory
  type: reference
  originSessionId: e0914236-135a-41c6-a730-575bdd252d2f
  modified: 2026-09-25T05:32:46.086Z
---

**Location.** TuBe SEO is a SaaSassins product. Its local folder is `C:\Users\dtucc\OneDrive\Documents\Claude\SaaSassins\TuBe SEO\`.
- It holds a campaign kit plus `source-repo/`, a clone of `github.com/mbennett210/voice-vault`. The branch is **`master`**; the folder's own CLAUDE.md wrongly says `main`.
- Contributors: Michael Bennett (main), Kronelius, Daniel.
- Pulled to `9f6fcd2` on 2026-09-24 (Michael's Sep 25 UTC commits, which deployed the Sep 13 export). `npm install` was not run.
- **Owner decisions 2026-09-24:** cold scans ask **Google AI Mode only** (ChatGPT stays off: "JUST GOOGLE. THE CHEAPEST."). **We fix TuBe's code ourselves**, with no handoff to Michael. Pushing TuBe `master` deploys prod (Vercel + Render worker), so it needs the owner's explicit go.
- **Checking the worker (verified 2026-09-29).** Render AUTO-DEPLOYS tube-seo-worker on every push to master: f460e41's reaper ran 63 s after the push. `jobs.worker_id` = `srv-<svc>-<replicaset>-<pod>-1@<sha7>` (RENDER_GIT_COMMIT, set in `agent/worker/__main__.py`), so the job list shows exactly which commit is live.
  - Read it through the owner's Chrome (Claude in Chrome; the in-app browser is NOT signed in to TuBe) at tube-seo.vercel.app/admin.
  - `await import('<the page's /assets/supabase-*.js>')`: export `t` is the page's own client, running on the owner's session. Query `jobs` read-only (worker_id, status, times).
  - Only the owner's tenant jobs are visible. Prospect-scan jobs run under HOUSE_TENANT and are hidden.
  - Scan rows: Admin → Prospecting, via the React fiber `data` prop (rows with `completed_at`).
  - The batch line shows "N done · M unfinished". Unfinished = status≠done + sheet sites never scanned.
- Scan runs live in TuBe's Supabase project "Voice Vault" (`itknwemcotpwoxbtncxs`), table `prospect_scans`. There are **no TuBe credentials on this machine**: only `.env.example` files.

**Cold scan** (`agent/core/prospect_scan.py`, via DataForSEO):
- Measures domain + page authority (DR/UR).
- AI readiness / SEO health.
- **Google AI Mode** gets the recommendation question: "Who are the best {business_type} in {city}?".
- Perplexity gets a secondary question.
- ChatGPT is **opt-in only** (+2.7¢), never auto-added.
- Validated competitor extraction; GBP city resolve; per-prospect PDF + share link.
- Cost: ≈3.4¢/domain batched (4.2¢ single); 6.1¢ with ChatGPT.
- Inputs: domain (required), `business_type` (customer-language vertical; it drives the question), city (authoritative since the 2026-09-12 fix), plus email + first_name for the export.

**Export for outreach** (AdminDashboard.jsx, built 2026-09-13):
- Columns: email, first_name, company, city, business_type, competitor_1, competitors, domain_authority, ai_visibility, ai_verdict, segment, report_link, subject, hook, domain, scanned_at.
- Segments: ELIGIBLE_GAP / MENTIONED_SOFT / CITED_EXCLUDE / UNSCANNED.
- Send list = ELIGIBLE_GAP rows with email + first_name + business_type. Everything else goes to outreach-review.csv.
- The hook/subject copy is "pending sign-off".
- `docs/COLD_EMAIL_EXPORT.md` still says "not built", which is stale.

**History.** The 2026-09-10 WA law-firm run (150 firms, 137 done) had bad targeting: 14% generic question, 26% wrong city, directory "competitors". Only 44 were sendable. See `docs/PROSPECT_SCAN_TARGETING_FIX.md`. Fixed 2026-09-12/13, then re-run.

**Mismatch vs LeadStart's plan.** LeadStart's `docs/plans/tube-seo-launch-sequence.md` (draft campaign `a23526b3…`) needs `buyer_question` + `fix_line`, which the export doesn't emit. Its copy says "I asked ChatGPT", but ChatGPT is off by default. It also has a Generic-inbox cohort, which the export sends to review.

**Sep-10 run validated 2026-09-25.** Source: `Downloads\prospects-f2a368a6\results.csv`, 132 rows, all scanned 2026-09-10, i.e. PRE-fix.
- **Ground truth lives in each row's report page (share link), not in results.csv.** The page carries the verbatim recommendation question, the "X answered" engine, and each competitor tagged "named by <engine>".
- results.csv's `business_type` is the sheet label, not what was asked.
- 70/132 questions were valid (law vertical + the firm's real city per LeadStart). 62 were invalid: wrong city 31, generic 20, off-topic 14, malformed vertical 11 (overlapping).
- Of the 70 valid questions: 33 already cited, 12 mentioned.
- **21 sendable** after dropping: 5 self-mentions the scan missed (AI named the firm's legal name), and the auto large-firm/nonprofit exclusion (FisherBroyles).
- Output files are in `validated\`: outreach-send, outreach-review, rescan-upload (TuBe CSV format), validation. Builder: scratchpad `t21-build-outreach.mjs`.
- TuBe export bug: `validCompetitors`' domain-label overlap drops legit firms whose names contain generic words ("group", "office", "legal"). Also, the brand-based verdict misses legal-name self-mentions.
- **Correction 2026-09-24:** my validator compared city only. 2 more questions named the wrong state ("Everett, British Columbia", "Vancouver, OR"), so it's **68 valid of 132, not 70**.

**Verdict flaws (verified in code + all 132 report pages, 2026-09-24):**
- `summary.ai_cited` / `ai_mentioned` count BOTH general probes: the Google AI Mode "who's best" answer AND Perplexity's secondary cost question. `_ai_state` ranks "cited" (domain in source links) above "mentioned" (named), even when the firm is not named. Result: 3 of 33 "cited" firms were never recommended and were wrongly excluded (bellevuewills, dpearson, riofoltz).
- **Self-mentions:** `brand_mentioned` only checks brand + host. The worker payload per firm is `{domain, business_type, seed_query, markets}` (`worker/handlers/prospect.py`, `run_prospect_scan` ~L242). Company legal name and owner never reach the scanner. So 7 firms named as e.g. "Mc Bride Law Office", "Castle Law Firm" or "Church Rietzke Johnson PLLC" were either marked "not cited" or listed as their own competitor.
- **Position is not stored.**
  - The report's per-question "AI recommended" list keeps the answer's order, but it omits the prospect and is capped at 6. The excerpt shows only 520 chars.
  - The DB keeps `answer_excerpt[:3000]`.
  - Same-question firms share one cached answer. That let me recover rank for 10 of 42 named firms (`t22-named.mjs` / `t23-groups.mjs` in the scratchpad).
  - Of the 68 valid questions: 26 not named, 1 named #1, 9 named but not first, 11 near the top, 21 unknown.
- **`competitor_1` is NOT the top pick.**
  - The export (`AdminDashboard.jsx` ~L588) reads `m.competitors_named`, which the scanner sorts by engine count, then alphabetically.
  - It matched Google's actual #1 in only 1 of 21 send rows. My `t21` send file copied the same order.
  - The fix is to take the order from the recommendation probe's answer: each name's first offset in the answer text.
  - Also, "Best Law Firms" (a ranking site) slipped through as a competitor.
- **Owner copy decision 2026-09-24:** one email covers both "not named" and "named but not first". It names Google's #1 firm; firms at #1 are skipped. The wording must be about the competitor ("X came up first … report shows where you stand"), not "came before you", because a not-named firm's report says "You never came up".
- **Report links never expire.** `/api/prospect-report?id=<scan uuid>` serves `report_html` straight from `prospect_scans`.

Related: [[project_scrapio_attorney_trial]].
