---
name: apify-fingerprint-fetch-engine
description: Proven anti-bot fetch engine (saasassins-scraper-engine.zip) — the curl_cffi TLS/JA3 fingerprint tier that hit 144/144; blueprint for the Phase-3 site_scrape actor
metadata:
  type: reference
---

`C:\Users\dtucc\Downloads\saasassins-scraper-engine.zip` — a standalone,
battle-tested 4-tier anti-bot fetch waterfall the owner built previously. It is
the reference blueprint for the Phase-3 `site_scrape` actor in
[[RESUME-WATERFALL-SETTINGS]] (folded into that doc's Phase-3 design 2026-08-24).

**The key technique we lacked:** tier 2 = TLS/JA3 + HTTP-2 **fingerprint
impersonation** via Python `curl_cffi` (`impersonate=chrome`), NO browser. Most
small/mid sites gate on the client's TLS handshake fingerprint (Akamai, many
WAFs), not on a JS challenge; Node's undici has a non-browser JA3 and is blocked,
but curl_cffi reproduces a real Chrome fingerprint so the same plain GET gets
through and the content is already in the static HTML. Measured 144/144 (100%)
recovery on a hard anti-bot set at ~250ms/req, $0 — replacing most paid
Scrapfly calls. This is the network-layer fingerprint; puppeteer-extra stealth
is the browser-layer one. Our original Phase-3 plan had only the browser layer.

**Waterfall (fast/free → slow/paid):** direct undici → curl_cffi fingerprint →
Playwright+stealth → Scrapfly ASP. Files worth copying near-verbatim:
`src/fetchPage.ts` (the tier orchestrator + `accept()` predicate + block
heuristics + SSRF guard + per-domain politeness), `src/fingerprint_fetch.py`
(curl_cffi helper, one JSON line out), `src/fingerprintFetch.ts` (Node→Python
`execFile` shim), `src/scrapFly.ts` (paid client + consecutive-429 circuit
breaker). Also ships a Brave SERP client (`braveSearch.ts`) — a separate
primitive, possible future SERP-based email tier, out of scope for Phase 3.

**Two hard-won details to adopt:** (1) block detection uses a high-precision
interstitial PHRASE list, and deliberately does NOT reject on page smallness —
the reference warns "<500 chars" drops legit tiny company/SoS pages (this
CONTRADICTS the original Phase-3 escalation rule, now fixed). (2) `accept(html)`
predicate lets a clean-but-contactless page fall through to a browser render
instead of scoring a miss.

**Architecture fit:** curl_cffi needs a Python subprocess + Playwright needs
headful Chromium → cannot run on Vercel/serverless, but both run in an Apify
actor's Docker container (custom Dockerfile: node-playwright base + `pip install
curl_cffi==0.13.0`). This VALIDATES the private-Apify-actor decision. Deps:
`playwright`, `playwright-extra`, `puppeteer-extra-plugin-stealth`,
`curl_cffi==0.13.0`. Related: [[apify-cost-model]].
