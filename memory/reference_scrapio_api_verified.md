---
name: reference_scrapio_api_verified
description: "Scrap.io API behaviour verified live 2026-09-24 (types[] multi-category, free skip_data counts, block-list stubs, HTTP 202 while refreshing, Basic-plan limits) — src/lib/scrapio/ predates these and is partly stale"
metadata:
  node_type: memory
  type: reference
  originSessionId: e0914236-135a-41c6-a730-575bdd252d2f
  modified: 2026-09-27T03:51:25.867Z
---

Verified live with the org's Scrap.io key (stored in `organizations.scrapio_api_key`, LeadStart Agency) on 2026-09-24:

- **Plan:** Basic, 10,000 export credits/month, reset on the renewal date (2026-10-08), **no rollover**. Basic = **city-level search only** (no admin1/admin2/whole-country/radius/polygon). City search = `country_code=US&admin1_code=WA&city=Seattle`.
- **Multi-category:** `types[]=a&types[]=b` (≤5 on Basic). `type[]` → 422; `type=a,b` → silently 0 results. `src/lib/scrapio/client.ts` only sends a single `type`.
- **Free counts:** `skip_data=1` (use `per_page=1`) returns `meta.count` = total matches and costs 0 credits.
- **FAIR-USE SEARCH QUOTA: counts are free in credits but NOT unlimited.**
  - On 2026-09-26, a city-by-city sweep of every OR (240) and CA (~100 of 482) city (up to 3 searches per city) came on top of the earlier WA statewide sweeps. It tripped HTTP 403 `search-fair-use-count-error`: "exceeded the quota of fair use for searches. Please contact support to unlock your account".
  - After that, EVERY `/gmap/search` is refused, and the account stays locked until Scrap.io support unlocks it.
  - While locked, calls still return 403. The count scripts read those as 0, so an all-zero result means "check the raw status".
  - **Never sweep whole states again.** Count only the handful of metros you plan to pull, and throttle.
- **Block list:** `POST /blacklists/{name}` `{type:"place_id",data:[…]}` (100/call); apply with `blacklists[]=name` (default = all lists). Owned places STILL count in `meta.count` and still take page slots, but come back as stubs `{google_id, blacklisted:true}` and cost 0.
- **HTTP 202:** data pulls can return 202 with `meta.status:"updating"` AND a full `data` page — treat 202 as success (a script that only accepted 200 lost a paid page on 2026-09-24). Rows can carry `status:"scraping"` (website data mid-refresh).
- **Re-pulls are free:** re-requesting a place already charged within 30 days costs 0 (verified).
- **Filter names:** reviews = `gmap_reviews_count_gte`; `src/lib/scrapio/filters.ts` names like `gmap_reviews_min` are stale. `gmap_has_website`, `gmap_is_closed`, `website_has_emails` are right.
- **IDs:** `place_id` is Google's `ChIJ…` id = `contacts.google_place_id`, so dedupe against Maps-vein contacts works.
- **Ordering:** pages follow Scrap.io's internal id, NOT Google's ranking, so unfiltered pulls skew to low-review corporate firms and single-lawyer listings. A reviews floor restores the Apify-like "established firm" mix.

**Unlocked, then guarded (2026-09-29).** The owner reported that Scrap.io support unlocked the account.
- Every search now goes through the shared ceiling: `scrapio_search_log` and `claim_scrapio_search`, migration 00135 (see [[feedback_no_bulk_sweeps_without_asking]]).
- `src/lib/scrapio/client.ts` used to retry a 429 and any 4xx three times. It no longer retries a search at all, and never retries a 403/429.
- It still sends a single `type` and uses the stale filter names. It's dormant: no screen calls its search, and `run-prospect-searches` isn't scheduled.

Block list `leadstart-<orgId>` was seeded with all 597 contact place ids on 2026-09-24. The Settings → API "Reset blacklist" button deletes that same list. Trial context: [[project_scrapio_attorney_trial]].
