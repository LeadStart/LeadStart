---
name: project_maps_diy_flow
description: Client-facing DIY Google-Maps search flow (D+cart, Smart Search picker, multi-region) — design locked, backend foundation shipped, Phases 2–5 remain
metadata:
  type: project
---

Building a **client-facing DIY Google-Maps lead-search flow** — "customers run their own search" — as a sequential **"D + running cart"** experience: left = "Where are your customers?" Smart-Search location picker + ready-to-run audience cards ("+ Add", whole card clickable, no per-card price); right = a sticky "Your search" cart (Areas / Audiences / Enrichment / lead count / outcome estimate / Run) that centers in the viewport on scroll.

**Locked decisions:** location picker = **Smart Search** (grouped, state-qualified disambiguation dropdown); **multi-region** (add several areas — one actor run per area, merge/dedupe by `google_place_id`); **metro removed**; **no business-count estimates**; outcome-tier pricing per delivered lead ($0.05 record → $0.30 verified personal email), same $/lead regardless of area count. Location maps to the compass actor's **structured geo fields** (city/county/state → nested fields; **zip → postalCode + country ONLY**; full state NAMES; **never emit `locationQuery` alongside structured** — 📍 Location overrides 📡 Geolocation). One area = one run.

**SHIPPED to prod — Phases 1–5 (admin surface complete, 2026-08-27).** Commits `deb0642` (foundation) · `38ee657` (P2 cron fan-out) · `dc12c11` (P3 route+gazetteer) · `df14ad7` (P4–5 picker+mount). Migrations `00094` (maps_searches.area_index) + `00095` (geo_places) APPLIED to prod; `geo_places` SEEDED (22,646 rows). The cron fans out one compass run per structured area and merges/dedupes by `google_place_id`; the picker is `maps-diy-panel.tsx` (mounted in the Prospecting "Business (Google Maps)" tab, replacing the deleted `MapsSearchPanel`).

**geo_places is the durable shared gazetteer** — 51 states + 3,143 counties + 19,452 cities, served by `geo-typeahead` (nothing in the browser bundle, ~2ms indexed lookups). It's REFERENCE data both veins' pickers share (Maps now; the LinkedIn fork later, replacing the retiring Scrap.io type-ahead) — sharing the dictionary, NOT the vein logic. Reseed via `scripts/seed-geo-places.mjs` (source = committed `supabase/seed/geo-places.tsv`). Bundled `src/lib/geo/us-states.ts` holds the 51-row abbr↔name map (the only geo bit bundled).

**Remaining — Phase 6 ONLY (client portal), a HARD STOP for Daniel's surface decision.** New `/client` prospecting route + client auth/RLS on maps_searches/geo_places + billing-ledger hooks (the delivered-outcome ledger prices against outcome-tier $0.05→$0.30/lead). The admin build is the reference. WARNING: a valid multi-area search POST makes a `pending` row prod's cron grabs → a real PAID multi-region Apify run — any live paid test needs a $ cap ([[feedback_ask_spend_budget]]).

**Why:** Maps and LinkedIn veins are deliberately SEPARATE (Maps = businesses/name-less/structured-area; LinkedIn = people/named/ICP+multi-location, no zip/county) and must not be conflated — they meet only at enrichment ([[project_contact_status_source_of_truth]] area). Multi-region for Maps is what aligns it with LinkedIn for an eventual merge.

**How to apply:** the full build spec + acceptance checks + standing rules live in the repo **HANDOFF.md** top entry (2026-08-27). A LinkedIn *client* flow is a separate future initiative, not this build. Respect [[feedback_local_only_dev]] (push = prod deploy) and [[project_apify_cost_model]] ($ cap before live paid runs).
