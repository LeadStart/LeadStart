---
name: project_apify_cost_model
description: What the Prospecting cost estimate does/doesn't count; Apify's real pricing layers and the HarvestAPI bundling
metadata:
  type: project
---

The LinkedIn-sourcing cost estimate in `linkedin-search-panel.tsx` models ONLY marginal per-result actor charges (DEPTHS + ENRICH_RATES). It does not count anything at Apify's platform/subscription layer. Researched 2026-08-23 (rates are 2026 list prices — re-verify, they change).

**The one genuinely uncounted cost = the monthly plan floor.** Apify plans: Free ($0 + $5 usage), Starter $29, Scale $199, Business $999/mo. It's prepaid platform usage, but **unused credit does NOT roll over** — expires each cycle. So at low volume you pay the plan floor regardless of per-search spend. Our estimate never shows this.

**Good news — the scary costs are already bundled.** HarvestAPI actors are pay-per-event and all-inclusive: "you are not charged for the Apify platform usage, but only a fixed price for specific events." So residential proxy ($8/GB) and compute units ($0.20/CU) are baked into the per-result price and do NOT bill separately for our published-actor usage. No monthly rental either (Apify retires rentals 2026-10-01). Extra-concurrency/RAM/storage add-ons only apply if you run your OWN actor — not us.

**Our per-result rates are approximate and plan-blind.** Published HarvestAPI (per 1K): Profile Details (Full) $4/1K = $0.004 (our modal `full`=0.01, over); Full+email $10/1K = $0.01 (modal 0.012); Company-employees basic $3/1K Free/Starter vs $1.50/1K Business (plan-dependent 2×). Our flat rates don't scale by tier. The code comment already flags "Short-mode search pricing confirmed on first live run."

To get real numbers, query the Apify account API with the key in Settings → Integrations: current plan, month-to-date usage, actual per-run costs. That replaces all estimates. Related: [[project_no_warmup_pool_deliberate]] (pre-send verification via Million Verifier is the other prospecting cost, shown separately in the modal).

**2026-08-24: the plan floor became the outage.** The org account (`indispensable_nonagon`) is on the **FREE plan — $5/month hard cap**, and hit $5.03 mid-enrichment (cycle 07-29→08-28). Apify then 403s every run start (`platform-feature-disabled: "Monthly usage hard limit exceeded"`), which failed the waterfall phase after 3 retries. Fix = upgrade to Starter ($29/mo) in Apify Console → Billing, or wait for the Aug-28 cycle reset. Check live state via `GET /v2/users/me/limits` (used in the 2026-08-24 diagnosis). Biggest consumer: `harvestapi/linkedin-profile-search` in Full+email mode (~$0.31 per 23-profile page); one `vdrmota/contact-info-scraper` run cost $3.96.

**Run-progress gotcha (fixed 2026-08-24):** the Apify run object's `stats` has NO `datasetItems` field (verified live — runtime/memory/CPU only; an earlier session invented it, so sourcing progress sat at 0 all run). Live progress = `GET /v2/datasets/{defaultDatasetId}` → `itemCount`, readable mid-run; `ApifyClient.getDatasetItemCount()` wraps it. Actors push per-profile in Full modes, per 25-result page in Short mode.
