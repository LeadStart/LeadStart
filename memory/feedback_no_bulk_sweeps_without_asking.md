---
name: feedback_no_bulk_sweeps_without_asking
description: "Never run a large automated job against an outside service (even \"free\" calls) without asking the owner first with the rough call count; scripts must stop on the first 403/429"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 51e46bb0-43e1-46ce-a904-34b1bd5907c4
  modified: 2026-09-27T04:05:40.997Z
---

On 2026-09-26 I ran ~1,800 Scrap.io "free" count searches over three days to size markets: every city in WA, then OR, then part of CA. It tripped Scrap.io's fair-use search quota, and the account was locked until support unlocks it. That blocked the West Coast run. The owner was furious: "WHY WOULD YOU HAVE DONE THAT".

**Why:**
- Free in credits is not unlimited. Outside services have rate/fair-use limits that aren't published.
- The owner had just asked to plan before spending, and had already suggested focusing on urban centers.
- The sweep also sized far more than would ever be pulled (hundreds of cities for a dozen-city pull).

**How to apply:**
- Before any bulk job against an outside API (Scrap.io, Apify, DataForSEO, MV, etc.), even a free or read-only one, tell the owner the rough number of calls and get a go.
- Size only what will actually be acted on: e.g. count only the cities planned for the pull.
- Every script must stop on the first 403/429 or error body. Never map errors to 0 and carry on.
- An all-zero result means check the raw response first; never retry it.

**Hard guard since 2026-09-29.** The owner asked me to "ENSURE THOSE CRAZY # of searches NEVER HAPPENS AGAIN" (pushed 0d4362a; migration 00135 applied).
- Every Scrap.io `/gmap/*` call must go through `src/lib/scrapio/client.ts` (app) or the skill's `scripts/scrapio.mjs`. Both claim a slot first: `claim_scrapio_search()` logs the call in `scrapio_search_log` and refuses past 150 per 24 hours, 400 per 7 days, 1,000 per 30 days. The skill adds a limit of 100 per run.
- Searches are never retried. With no claim, nothing is sent.
- The 22 throwaway scratch scripts that called Scrap.io directly (the p3/p45/p49/p6/p7 sweeps plus e0914236's t1…t9) went to the Recycle Bin.
- The rule is at the top of the repo's `CLAUDE.md`, so every session on both PCs sees it.
- **Never write a script that calls scrap.io directly.** Import the skill's `sc()` instead.
- A REFUSED answer is the guard working. Report the numbers; never work around it. A ceiling rises only through a new migration, with the owner's go.

Related: [[reference_scrapio_api_verified]], [[project_scrapio_attorney_trial]], [[project_tube_pipeline_skill]].
