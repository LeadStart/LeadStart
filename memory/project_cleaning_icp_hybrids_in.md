---
name: cleaning-icp-hybrids-in
description: Cleaning-ICP saved searches deliberately include residential+commercial hybrids — do not add NOT-residential keyword exclusions
metadata:
  type: project
---

Owner decision 2026-08-25: the four cleaning saved searches (`linkedin_search_presets`) keep `"commercial cleaning" OR janitorial` + industry 122 (Facilities Services) with **no residential exclusions** — hybrid residential+commercial companies are in-ICP. The two "Cleaning —" presets are a deliberate size-split pair of one search (SMB owners A–C / mid-large revenue leaders D–I, mirroring the waterfall's size_threshold=50), not a broader net.

**Why:** hybrids still run janitorial operations and are wanted leads; the quoted phrase + Facilities Services facet already exclude pure-residential (maid/house-cleaning) companies by construction.

**How to apply:** don't "tighten" these presets with `NOT residential NOT maid` boolean strings (the keyword field passes verbatim to LinkedIn search, so it would work — it was offered and declined). Related: [[mv-credit-cost-basis]].
