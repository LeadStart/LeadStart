# Phase 4 — Master Contacts Pool: Design

> Status: DESIGN (for owner review). Author: Claude, 2026-08-31. Feeds the token
> product plan `C:\Users\danie\.claude\plans\ok-we-need-a-gentle-peach.md`
> (Phase 4). Nothing here is built yet. Phases 0-3 + 5 are live/committed.

## 1. Goal (from D3)

A **shared, platform-owned contacts pool** so a business/person sourced once is a
durable, resellable asset (near-100% margin on resale), with:

- **Per-buyer ownership ledger** — who has paid for which master contact.
- **Cross-buyer dedup** — never bill a buyer for a record they already own.
- **Segment cache** — a repeat pull of a recently-sourced (segment, area) serves
  from our DB, no actor re-run.
- **Coverage readout** — "you own N of ~M in this segment."

## 2. What we're building on (verified against the code)

- **Buyer contacts today live in the buyer's own org** (`contacts.organization_id
  = buyer org`), in the SAME table the agency uses. Billing is settled **per
  search** off `maps_searches.delivered_counts` / `linkedin_searches.delivered_counts`
  (Phase 3), NOT per contact and NOT per owner. There is no master pool.
- **The cold-email sender is insulated.** `run-native-sequences` reads
  `campaign_enrollments.contact_id`, never scans `contacts` by org. So changing
  how buyer contacts are scoped does not touch agency sending, as long as
  enrollment rows still resolve to a contact row.
- **The enrichment engine is coupled to org-scoped `contacts`** across ~31 files
  (`run-apify-enrichment`, the import libs, `finalizeOutcomes`). It loads
  contacts by `run.organization_id`. Forking it to a different store is the
  single biggest risk.
- **Two org-scoped UNIQUE dedup indexes**: `idx_contacts_org_email_unique
  (organization_id, lower(email))`, `idx_contacts_org_place_unique
  (organization_id, google_place_id)`. Global (cross-org) dedup collides with them.
- **`contacts` RLS is owner/va-only** (`contacts_admin_all`); buyers already read
  contacts via the service-role only, never the browser.
- **Provenance is thin but present:** `source`, `enrichment_data.maps_search_id /
  linkedin_search_id`, `google_place_id`, and the recomputable per-contact
  classifier `src/lib/enrichment/outcomes.ts`. There is NO `acquired_at`,
  `owned_by`, or ownership column, and NO master table.
- **Config stubs already exist with no reader:** `token_pricing_config.
  segment_cache_freshness_days` and `.master_reverify_cadence_days` — the
  intended home for master-pool cadence.

## 3. Hard constraints

1. **The agency's `contacts` + cold-email flow must not break.**
2. **Do not fork the shared enrichment engine** if avoidable (it processes every
   org's enrichment; a bug there breaks agency deliverability).
3. The org-scoped unique indexes + owner/va RLS are load-bearing — do not relax
   the `organization_id NOT NULL` + org-equality invariant on `contacts`.

## 4. Design options

### Option A (RECOMMENDED): enrich in place → promote to a master pool → own via a ledger
- Buyer searches keep sourcing + enriching into the **buyer's own org**
  `contacts` (enrichment engine UNCHANGED — the key risk avoided).
- New **`master_contacts`** table: a platform-owned canonical pool, globally
  deduped by a natural key (google_place_id / linkedin_url / lower(email)).
- New **`contact_ownership`** ledger: (buyer org, master_contact_id, search_id,
  tokens_charged, acquired_at).
- At **settlement** (inside/after `finalizeOutcomes`, only for buyer searches),
  PROMOTE each delivered contact into `master_contacts` (upsert by natural key,
  merge canonical enrichment) + upsert an ownership row. Idempotent + additive,
  same shape as the token settlement it rides alongside.
- Sourcing checks `master_contacts` first for the segment cache + resale.
- **Pros:** agency + enrichment engine untouched; purely additive; delivers
  resale + cross-buyer dedup + segment cache incrementally; leans on the
  recomputable classifier (no per-contact provenance write needed).
- **Cons:** a delivered buyer contact exists in two places — the buyer's org
  `contacts` (their working list) and `master_contacts` (the platform asset).
  Deliberate: the master row is the resellable asset + the cross-buyer index; the
  buyer-org row is the buyer's usable copy.

### Option B: shared platform-pool org
- Route all buyer contacts into a single platform org; ownership via a ledger;
  cross-buyer dedup falls out of the existing org-scoped unique indexes.
- **Pros:** one physical store, no duplication.
- **Cons:** tangles the org model — the enrichment run's org, the search's org
  (billing), and the contact's org would diverge, and `finalizeOutcomes` loads
  contacts by `run.organization_id`. More invasive to the engine's assumptions.

### Option C: master pool as the primary store (enrich in master)
- Fork the enrichment engine to read/write `master_contacts` for buyer searches.
- **Pros:** no duplication; the literal "shared pool as primary."
- **Cons:** forks the shared enrichment engine — the highest-risk path.

## 5. Recommendation: Option A

It isolates the change from the two things that are both load-bearing and
fragile (the agency contacts + the shared enrichment engine), while still
delivering every D3 outcome. The duplication cost is real but bounded, and buys a
clean rollout. Detail below assumes Option A.

## 6. Schema (additive migrations)

```
master_contacts
  id uuid pk
  natural_key text unique          -- 'place:<google_place_id>' | 'li:<lower(url)>' | 'email:<lower(email)>'
  vein text                        -- maps | linkedin (origin)
  first_name, last_name, email, company_name, title, phone, company_phone,
  company_email, location, linkedin_url, company_linkedin_url, company_domain,
  google_place_id text,
  enrichment_data jsonb,           -- canonical merged enrichment
  email_verification_status text, email_verified_at timestamptz,
  best_tier text,                  -- from outcomes.bestTier, for coverage/reporting
  first_acquired_at timestamptz default now(),
  last_verified_at timestamptz,
  updated_at timestamptz default now()
  -- RLS: service-role only (platform-owned). Buyers never read it directly.

contact_ownership
  id uuid pk
  organization_id uuid  -- the buyer org
  master_contact_id uuid references master_contacts(id) on delete cascade
  search_id uuid, search_kind text,   -- which pull earned it
  acquired_at timestamptz default now()
  unique (organization_id, master_contact_id)   -- a buyer owns a master contact once
  -- RLS: buyer reads own (organization_id = get_my_org_id() AND get_my_role()='buyer')

segment_pulls                        -- segment cache ledger
  id uuid pk
  segment_key text unique            -- hash(vein + normalized terms + area)
  vein text, terms text[], area text,
  last_pulled_at timestamptz,
  master_contact_count int           -- how many master contacts this segment holds
```

Also wire the two existing config stubs: `segment_cache_freshness_days` (cache
window) and `master_reverify_cadence_days` (background re-verify).

## 7. Flows

- **Promotion (at settlement).** In `finalizeOutcomes`, for buyer searches only
  (has a hold), after `delivered_counts` + `settleSearch`: for each delivered
  contact, upsert `master_contacts` by natural key + upsert `contact_ownership`
  for the buyer org. Idempotent; runs alongside the existing per-search settle.
- **Cross-buyer dedup before charging.** Per-buyer dedup ALREADY works (the
  org-scoped import dedup skips a buyer's already-owned leads → 0 charged). The
  ownership ledger extends this so a buyer's overlap with the pool is recognized.
- **Segment cache (serve-from-DB).** At buyer search creation, compute
  `segment_key`. If `segment_pulls` shows a fresh pull (within
  `segment_cache_freshness_days`), serve matching `master_contacts` into the
  buyer's org + grant ownership + charge for the newly-owned rows, WITHOUT an
  actor run. Rate-limit repeat pulls of the same segment. This is the resale path
  (~100% margin: no sourcing/enrichment cost on a cache hit).
- **Coverage readout.** "You own N of ~M in this segment" = ownership count vs
  `master_contacts` count for the segment.

## 8. Decisions — LOCKED (owner, 2026-08-31)

1. **Architecture = Option A.** Enrich in the buyer's org as today, promote
   delivered contacts to the shared pool at settlement, own via a ledger. Agency
   contacts + the shared enrichment engine stay untouched.
2. **Buyers keep/download their contacts.** They get a per-org working copy (the
   `contacts` row) AND ownership of the master row — confirms A's duplication.
3. **No resale discount.** A cache-served (resold) contact is charged the SAME
   token price as a freshly-sourced one. Max margin; no "seen before" incentive.
4. **Simple segment key (vein + terms + area), NOT richer ICP facets.** Dedup is
   BROAD — every matching hit counts for dedup purposes (a buyer is never charged
   twice for a record they own, regardless of the finer ICP facets of the pull).
5. **Re-verify (`master_reverify_cadence_days`) = DEFERRED.** It is defined by
   email decay (verified emails go stale ~2-3%/month; a background Million
   Verifier re-check of pool emails older than N days keeps resold contacts
   deliverable). Nothing to re-verify at launch (empty pool), so wire it as a
   later maintenance pass once the pool holds aged data.

## 9. Rollout (phased, low-risk → high-risk last)

1. **Schema** (master_contacts + contact_ownership + segment_pulls) — additive,
   zero agency impact. Rollback-verify + apply.
2. **Promotion step** — populate the pool at settlement, behind a flag. Read-only
   from the buyer's perspective; builds the asset.
3. **Coverage readout** — pure read; safe.
4. **Segment-cache serve** — the only piece that changes sourcing behaviour;
   ship last, behind a flag, after the pool has real data to serve.
5. **Background re-verify** — optional maintenance cron.
```
