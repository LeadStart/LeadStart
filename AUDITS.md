# LeadStart, Audit Registry

Systematic subsystem audits: find wide (multi-agent), verify adversarially
(every candidate independently confirmed or refuted), register here. Modeled on
rainier-app's audit registry.

## Completed audits

| Date | Scope | Confirmed | Refuted | Clean areas | Status | Doc |
|---|---|---|---|---|---|---|
| 2026-08-30 | Apify actor + spend subsystem | 53 (+1 partial, +13 verifier-found) | 4 | ~69 | **FIXES ON MASTER** (landed in 7f4493b) | [APIFY_SPEND_AUDIT.md](APIFY_SPEND_AUDIT.md) |
| 2026-09-05 | Native send runtime + cron worker fleet (23 routes) + 3 bolt-ons (tsc-to-zero, live RLS delta, error boundaries) | 86 (of 98 candidates; 10 superseded) | 2 | 93 | **FIXES SHIPPED LOCAL** (7 commits, unpushed; migration 00126 written, not applied) | [SEND_RUNTIME_AUDIT.md](SEND_RUNTIME_AUDIT.md) |

## Pathway checklist (candidate audits, Tier 1 = money · security · corruption first)

- [x] **Apify actor + spend subsystem** (Tier 1, money): audited 2026-08-30, fixes landed on master in 7f4493b
- [ ] Billing/credit surfaces (MV credits, Findymail credits, future client billing ledger) (Tier 1, money)
- [x] RLS / authz pass on newer tables (post-00100 delta) (Tier 1, security): live catalog checked 2026-09-05 as a bolt-on lane, 2 gaps, migration 00126 written (not applied); the DB-wide default grants posture (all 60 tables grant anon/authenticated, RLS is the only barrier) is a separate follow-up
- [x] **Native send pipeline** (ramp, caps, verification gate, suppression) (Tier 1, money+reputation): audited 2026-09-05, fixes shipped local, [SEND_RUNTIME_AUDIT.md](SEND_RUNTIME_AUDIT.md)
- [ ] Enrichment phase state machine (leases, retries, double-processing) (Tier 2). Parked here from the 2026-09-05 send-runtime audit: SEND-54 (pattern-finder MV verdict never cached, so the send gate re-bills the same address) and CRON-09 (run-apify-enrichment releases its lease inside setActive before the same-tick ingest; an overlapping tick can double-count a batch and start a second paid one)
- [x] **Cron worker fleet** (leases, stuck-run recovery, idempotency) (Tier 2): audited 2026-09-05, fixes shipped local, [SEND_RUNTIME_AUDIT.md](SEND_RUNTIME_AUDIT.md)

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
