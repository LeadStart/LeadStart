# LeadStart, Audit Registry

Systematic subsystem audits: find wide (multi-agent), verify adversarially
(every candidate independently confirmed or refuted), register here. Modeled on
rainier-app's audit registry.

## Completed audits

| Date | Scope | Confirmed | Refuted | Clean areas | Status | Doc |
|---|---|---|---|---|---|---|
| 2026-08-30 | Apify actor + spend subsystem | 53 (+1 partial, +13 verifier-found) | 4 | ~69 | **FIXES SHIPPED LOCAL** (verified: tsc + unit suites green; unpushed) | [APIFY_SPEND_AUDIT.md](APIFY_SPEND_AUDIT.md) |

## Pathway checklist (candidate audits, Tier 1 = money · security · corruption first)

- [x] **Apify actor + spend subsystem** (Tier 1, money): audited + fixes shipped local 2026-08-30, verified, pending push
- [ ] Billing/credit surfaces (MV credits, Findymail credits, future client billing ledger) (Tier 1, money)
- [ ] RLS / authz pass on newer tables (post-00100 delta) (Tier 1, security)
- [ ] Native send pipeline (ramp, caps, verification gate, suppression) (Tier 1, money+reputation)
- [ ] Enrichment phase state machine (leases, retries, double-processing) (Tier 2)
- [ ] Cron worker fleet (leases, stuck-run recovery, idempotency) (Tier 2)

## Recording rules

1. Every audit gets `<NAME>_AUDIT.md` at the repo root, a **living record**:
   findings stay forever, flipped to shipped/declined as they close.
2. Every candidate finding is independently verified: **CONFIRMED or REFUTED**,
   refutations recorded with reasons. Counts must reconcile:
   candidates = confirmed + refuted + superseded.
3. Areas checked and found clean are counted and listed, absence of findings
   is a result.
4. **Verification rig:** LeadStart has no sandbox Supabase. Server-side claims
   verify via READ-ONLY means only: the live Apify API (pricing/schema/run
   history, never starting a run), read-only prod DB queries via the
   Management API, and code reproduction with local scripts. **No audit ever
   starts a paid actor run, sends an email, or mutates prod.**
5. Fixes ship in root-cause batches ONLY on explicit owner go-ahead, each batch
   verified before its findings flip to shipped.
6. Register completions in this table + a dated HANDOFF.md entry (two-place rule).
