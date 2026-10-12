# Pay-per-hit email finders: where they get their data (2026-10-12)

Research for the SaaSassins cleaning-company pull, where the in-house waterfall finds a sendable owner email for ~23% of named owners. The owner excluded orchestration layers (Clay, Reverse Contact, BetterContact, FullEnrich) and subscription databases (Apollo). Every claim below carries its source; "not published" means the vendor says nothing.

**Caveat on evidence.** No published benchmark tests local service businesses. Every multi-tool comparison found is vendor-run on LinkedIn-sourced B2B contacts, and they disagree by 20-40 points on the same tools. The only local-business figure is a vendor's (LocalPipe): general finders "often land below 20% on Google Maps leads". Reddit tests cited on vendor pages could not be verified and are excluded.

## Three data models

| Model | Providers | What it means for small cleaners |
|---|---|---|
| Live pattern + SMTP, no stored database | Findymail, Enrow, Dropcontact, Anymail Finder, Datagma (mostly) | Same method as our own guesser, with better catch-all resolution and more patterns. Needs a company domain; cannot help the no-website firms. |
| Crawled web index | Hunter (650M public sources), Tomba (2B pages/month), Icypeas (open sources, monthly refresh) | Can surface addresses published anywhere on the web, including owner@ and info@ our scraper missed. |
| LinkedIn-derived database | Prospeo (143M emails), Snov, Wiza | Good only for owners who are on LinkedIn. |

Findymail (already wired in LeadStart for catch-all recovery only) has no database: "verified in real time, not exported from a database" ([findymail.com/email-finder](https://www.findymail.com/email-finder/)). Discolike is a company-discovery database billed per query plus per record, whose own docs say contact emails "should be verified before outreach" ([discolike.com](https://discolike.com/)); it is a sourcing tool, not a finder.

## Comparison (entry-tier list prices; "adj." divides by 1 minus hard-bounce minus wrong-domain from Dropcontact's 20k-contact test, the only test reporting both)

| Provider | Own DB / live | $/hit entry | $/hit best self-serve | Misses free | Catch-all | LinkedIn URL input | Min spend | Credit expiry | Adj. $/deliverable |
|---|---|---|---|---|---|---|---|---|---|
| Enrow | live, no DB | $0.017 | $0.0079 | yes (LinkedIn miss = 0.25 credit) | deterministic, included | yes | $17 | none on pay-as-you-go | $0.019 |
| Icypeas | open-source DB, monthly refresh | $0.019 | $0.0089 | yes | Google / M365 only | no | $19 | never | $0.020 |
| Datagma | pattern + SMTP | $0.0163 | $0.0093 | yes; catch-all results free | free | partial | $0 (100/mo free) | 12 months | $0.021 |
| Findymail | live, no DB | $0.049 ($49/1k) or $0.0198 ($99/5k) | $0.0085 | yes | proprietary, resolved | yes | $49 | 2x rollover | $0.021 |
| LeadMagic | multi-source DB + SMTP | $0.0198 | $0.0071 | yes | valid or not-found | no | $99 | 2-month bank | $0.024 |
| Prospeo | LinkedIn-derived DB | $0.0245 | $0.0125 | single lookups yes; bulk disputed | flag only | yes | $0 (100/mo) | none | ~$0.025 |
| Hunter | web-crawl index + guess | $0.0245 | $0.012 | yes | accept_all + score; charging not published | yes | $0 (50/mo) | monthly | $0.029 |
| Tomba | web crawler | $0.0178 | $0.0089 | yes | contradictory docs | yes | $0 (75) | 12 months | no independent data |
| Anymail Finder | live pattern + SMTP | $0.049 | $0.0109 | yes; RISKY free | signals; VALID possible | yes | $29 | rolls while subscribed | $0.066 |
| Snov.io | 500M DB | $0.039 | $0.0074 | no: "yellow" (unverifiable) charged | charged, unverified | bulk upload | $39 | 30 days | n/a |
| Dropcontact | live, no DB | $0.158 | not mapped | yes | resolved | yes | $79 | monthly | too expensive |

Sources: [Enrow pricing](https://enrow.io/pricing), [Enrow docs](https://docs.enrow.io/api-reference/email-finder/find-single), [Icypeas pricing](https://www.icypeas.com/pricing), [Datagma pricing](https://datagma.com/pricing), [Findymail pricing](https://www.findymail.com/pricing), [Findymail docs](https://app.findymail.com/docs/), [LeadMagic pricing](https://leadmagic.io/pricing), [Hunter pricing](https://hunter.io/pricing), [Hunter API](https://hunter.io/api-documentation/v2), [Snov credits](https://snov.io/knowledgebase/what-is-a-credit/), [Anymail statuses](https://help.anymailfinder.com/en/article/what-are-the-possible-email-statuses-in-search-results-1comnl0/), [Dropcontact 20k benchmark](https://www.dropcontact.com/email-finder-benchmark), [Clay SMB segment test](https://www.clay.com/blog/work-emails-by-segment), [Growthtoday comparison](https://www.growthtoday.co/blog/best-email-enrichment-providers), [Anymail benchmark](https://anymailfinder.com/email-finder-benchmark).

## Recommended test: the same 200 owners through each

Ranked by expected cost per deliverable email at the smallest plan. All three take name + company domain, charge nothing on misses, and resolve catch-alls instead of flagging them.

1. **Enrow** (~1.9 cents per deliverable; $17 covers the test). Lowest hard-bounce rate of 15 tools in the only test that sent real mail (2.3%); accepts the LinkedIn URL as a second pass on misses. Risk: no small-business test includes it; 3 G2 reviews.
2. **Icypeas** (~2.0 cents; ~1 cent at the $39/4,000 tier; credits never expire). Highest accuracy in nearly every test (99.1% in Anymail's, 1.0% bounce in Dropcontact's); the only vendor explicitly pitching small businesses; a 1-credit Domain Scan returns info@ for firms with no named mailbox. Risk: lowest coverage in most tests; no LinkedIn URL input.
3. **Datagma** (~1.6 cents; 100 free credits a month cover the test; catch-alls free). Risk: 10.6% hard bounce and 12.8% wrong domain in Dropcontact's test.
4. **Findymail as a general finder** (already integrated; run on the current misses, not only catch-alls). Best coverage in the small-business-leaning tests (86% on Clay's under-500-employee set).

Skip: Snov (charges for unverifiable results), Anymail at entry price, Dropcontact ($0.158 per credit), the orchestration layers, Tomba (no independent evidence), Discolike (not a finder). Wildcard: LocalPipe, the only local-first tool (vendor claims only: 60% owner-email find rate on owner-operated businesses, usage pricing $0.015 per owner email; [localpipe.io](https://www.localpipe.io/)).

**Fair test design.** One list of 200 owners (name, company domain, LinkedIn URL) drawn from one batch, stratified by mail host and by whether our stack already found an email (~46 known-good as ground truth, ~154 misses for incremental coverage). Pass 1: name + domain through each API's single-lookup endpoint (never bulk CSV: Prospeo's bulk charges per row). Pass 2 on misses, where supported: LinkedIn URL. Every returned address re-checked through our Million Verifier, catch-alls through one neutral arbiter, then real first-step sends to count hard bounces. Metrics: hits, deliverable hits, hard-bounce %, wrong-domain %, incremental hits among the 154 misses, pairwise overlap, exact-match accuracy on the 46 known, credits actually debited (read the balance before and after). Repeat the winning pair on a second 200 before buying volume.
