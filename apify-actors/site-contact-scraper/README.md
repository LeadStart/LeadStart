# site-contact-scraper (Apify actor)

LeadStart's private Apify actor for the **site_scrape** enrichment method
(Phase 3 of the configurable enrichment waterfall). Per company domain it runs a
5-tier anti-bot fetch waterfall over the homepage + discovered contact pages and
extracts emails, phones, socials, and name-matched personal emails.

The fetch waterfall is ported from the proven saasassins engine (its curl_cffi
tier recovered 144/144 of a hard anti-bot set at ~250ms, $0). See
`RESUME-WATERFALL-SETTINGS.md` at the repo root for the full design.

## The fetch waterfall (fast/free → slow/paid)

| Tier | Mechanism | Cost | Beats |
|------|-----------|------|-------|
| 1. direct | plain HTTPS + Chrome UA (datacenter IP) | free | no protection |
| 2. fingerprint | curl_cffi TLS/JA3 + HTTP-2 Chrome impersonation, **no browser** | free | TLS/WAF gating (Akamai, many WAFs) |
| 3. fingerprint+proxy | same, over a residential IP | small | IP-reputation blocks |
| 4. playwright+stealth | real rendered browser | compute | JS-built pages |
| 5. unblocker | managed ASP+render_js (ScrapFly-class), key-gated | paid | hard Cloudflare/DataDome |

Each tier's result is gated by an `accept(html)` predicate; a rejected result
falls through. A per-domain `fetchOutcome` (`ok_http` / `ok_fingerprint` /
`ok_fingerprint_proxy` / `ok_browser` / `ok_unblocker` / `blocked` / `empty` /
`error`) is recorded so each run measures its own tier distribution.

## Files

```
src/
  main.ts             # Apify entry: read input, loop targets, push one record per domain
  scrape.ts           # per-domain: homepage → discover pages → fetch → extract → merge
  fetchPage.ts        # the 5-tier waterfall (SSRF guard + politeness + block heuristics)
  fingerprintFetch.ts # Node→Python shim for the curl_cffi tier
  fingerprint_fetch.py# curl_cffi TLS/HTTP-2 impersonation helper (+ proxy)
  unblocker.ts        # managed unblocker client + 429 circuit breaker (tier 5)
  discover.ts         # nav/footer link discovery + keyword priority (PURE, unit-tested)
  extract.ts          # email/phone/social/personMatch extraction (PURE, unit-tested)
test/                 # pure-logic unit tests (no network) — npm test
.actor/               # Apify actor.json + input_schema.json
Dockerfile            # Node+Chromium base + Python/curl_cffi
```

## Local checks (no Apify needed)

```bash
npm install
npm test        # extract + discover unit tests (pure, no network)
```

## Deploy (owner, one-time — needs Apify budget headroom)

1. `npm install -g apify-cli` and `apify login` (owner's Apify account).
2. From this folder: `apify push` — builds the Docker image (installs curl_cffi)
   and publishes the **private** actor. Pin build memory ≤1024MB.
3. Note the actor id (`<username>/site-contact-scraper`) and wire it into
   `src/lib/apify/providers/waterfall-scrape.ts` on the LeadStart side.
4. Smoke-test on the Apify console against 3 sites (one static, one JS-heavy, one
   with a published phone); confirm `usedBrowser` only on the JS-heavy one and the
   `fetchOutcome` distribution looks sane.

> Not deployable while the Apify account is at its free-tier cap — same gate as
> the rest of Phase 3's live steps (resets Aug 28, or on a Starter upgrade).

## NEVER

Add login, CAPTCHA-solving, or block-evasion beyond fingerprint-correct polite
fetching of public pages. The politeness guards (per-domain pacing + all-tiers-
blocked cooldown) and the SSRF guard are load-bearing — don't remove them.
