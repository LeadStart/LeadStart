---
name: project_mail_host_yield
description: "A Maps lead's email host (MX) is the strongest pre-enrichment yield marker (Microsoft 365 44% TuBe-ready vs 0–29% others); 2026-09-25 build 1–4 (mail-host tag, M365/Google-first runs, no-MX skip, published-address rule) is LOCAL, uncommitted"
metadata:
  node_type: memory
  type: project
  originSessionId: 51e46bb0-43e1-46ce-a904-34b1bd5907c4
  modified: 2026-09-25T19:24:53.490Z
---

**Finding (2026-09-25, 873 enriched WA law firms).** Share of firms that became TuBe-ready, by who hosts the firm's email:

| Host | TuBe-ready |
|---|---|
| Microsoft 365 | 44% |
| Google | 29% |
| Security gateways (Proofpoint, Mimecast…) | 22% |
| Other hosts | 18% |
| No MX | 9% |
| GoDaddy | 0% |

- Cause: Microsoft 365 rejects unknown recipients, so Million Verifier can confirm pattern guesses. Gateways, GoDaddy and small hosts accept all mail (catch-all).
- Best segment: Microsoft 365 + a specific practice area = 56% ready, ≈4.1¢ per ready lead. All firms average 7.4¢.
- Other markers are weaker: generic listings are 0% ready, 20–99 reviews do best, and city is noisy (~50 firms per city).

**Built 2026-09-25, owner said "Do all 1–4, with 3a and 3b". LIVE in production 2026-09-25.**
- Commits on master: `6751e9e` (enrichment + pool) and `e7c690f` (TuBe rule).
- Vercel deploy READY at 19:24Z.
- Rebased over another session's `20a7947` and `4f23119` (CSV adopt). The CSV adopt path matches contacts by email, and pooled firms have none.
1. `src/lib/enrichment/mail-host.ts`: MX lookup. Uses node DNS with a DNS-over-HTTPS fallback, because this sandbox refuses port 53. It stamps `enrichment_data.mail_host` in `importMapsPlaces`.
2. **Weak-host POOL.** Replaces the first "run them second" split; owner ruling 2026-09-25: "tagging method".
   - Which firms: Maps firms on gateway / GoDaddy / other / no-MX hosts. LinkedIn leads and unclassified hosts are never pooled.
   - Import tags them `pooled-weak-host` and never attaches them to the import's campaign. `enqueueEnrichment` never enriches pooled contacts, and pools any firm whose host is only resolved at enqueue.
   - Guards: push-to-campaign, candidate-contacts, enroll-existing and the admin enroll route all refuse pooled contacts (`skipped_pooled`).
   - Backstop: `run-native-sequences` fails any pooled enrollment.
   - Release: Contacts → Enrich (`contacts/enrich/start`) swaps the tag for `pool-released`. Module: `src/lib/enrichment/pool.ts`.
   - Why not reorder items inside one run: phases span the whole run, so it wouldn't deliver leads sooner.
   - Trade-off (873 firms): pooling cuts enrichment time and spend by ~35%, drops ~1 in 5 ready leads, and raises ready leads per hour by ~25%.
   - Weak-host firms are not more valuable. Gateway firms resemble M365 firms but sit behind the strictest filters. GoDaddy/other/no-MX firms skew solo.
   - Measure reply rates by host in the first campaign.
3. 3a: `tubeEmailStatus` in `handoff.ts` accepts a catch-all address that was read off the firm's own site (provider `site_scrape` / `decision_maker` / `site_published`). The address must be on the firm's domain and match the owner's name.
4. 3b: pattern_mv's catch-all pass swaps in the owner's published address (provider `site_published`) before Findymail.
5. #4: pattern_mv skips guessing when the domain has no mail server. Checked on 688 found emails: none was a guess on a no-MX domain.
6. Bundled with 3a: the `icpExclusion` mislabel fix. A private name (PLLC, "Law Firm", a .com "Law Center") overrides Google's "Government office" and similar categories.

Effect on wave 1: 98 → 113 TuBe-ready. 3b only applies to future runs.

**Verification so far:**
- Tests pass: mail-host 28, handoff 72, flow-map-sync 11, plus existing suites.
- Type-check: no new errors.
- PROSPECTING_FLOW.md and the Flow Map are updated.
- NOT browser-checked: another session's dev server was using this folder's `.next`.

**Follow-up:** Findymail finds are not in the published-provider set. If Findymail is ever enabled, decide whether the TuBe rule should accept them, since MV will still say catch_all.

Related: [[project_scrapio_attorney_trial]], [[project_tube_outreach_pipeline]].
