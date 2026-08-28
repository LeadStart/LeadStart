---
name: project_maps_diy_flow
description: Client-facing DIY Google-Maps search flow (D+cart, Smart Search picker, multi-region) — design locked, backend foundation shipped, Phases 2–5 remain
metadata:
  type: project
---

Building a **client-facing DIY Google-Maps lead-search flow** — "customers run their own search" — as a sequential **"D + running cart"** experience: left = "Where are your customers?" Smart-Search location picker + ready-to-run audience cards ("+ Add", whole card clickable, no per-card price); right = a sticky "Your search" cart (Areas / Audiences / Enrichment / lead count / outcome estimate / Run) that centers in the viewport on scroll.

**Locked decisions:** location picker = **Smart Search** (grouped, state-qualified disambiguation dropdown); **multi-region** (add several areas — one actor run per area, merge/dedupe by `google_place_id`); **metro removed**; **no business-count estimates**; outcome-tier pricing per delivered lead ($0.05 record → $0.30 verified personal email), same $/lead regardless of area count. Location maps to the compass actor's **structured geo fields** (city/county/state → nested fields; **zip → postalCode + country ONLY**; full state NAMES; **never emit `locationQuery` alongside structured** — 📍 Location overrides 📡 Geolocation). One area = one run.

**Shipped (master, commit `deb0642`, inert/additive):** `src/lib/apify/sourcing/maps-search.ts` — `MapsArea` + `geoFieldsForArea()` + `buildMapsSearchInputForArea()`; legacy `buildMapsSearchInput()` unchanged; test `scripts/test-maps-geo.ts` 26/26.

**Remaining (Phases 2–5, per HANDOFF.md top entry):** cron fan-out per area + migration on `maps_searches`; route accepts `areas[]` + a bundled US counties/states gazetteer; the real React component (match `maps-search-panel.tsx`); mount in the **admin Prospecting tab first** (client-portal exposure is a later, surface-decision-gated Phase 6).

**Why:** Maps and LinkedIn veins are deliberately SEPARATE (Maps = businesses/name-less/structured-area; LinkedIn = people/named/ICP+multi-location, no zip/county) and must not be conflated — they meet only at enrichment ([[project_contact_status_source_of_truth]] area). Multi-region for Maps is what aligns it with LinkedIn for an eventual merge.

**How to apply:** the full build spec + acceptance checks + standing rules live in the repo **HANDOFF.md** top entry (2026-08-27). A LinkedIn *client* flow is a separate future initiative, not this build. Respect [[feedback_local_only_dev]] (push = prod deploy) and [[project_apify_cost_model]] ($ cap before live paid runs).
