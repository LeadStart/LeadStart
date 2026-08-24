// site-contact-scraper — LeadStart's private Apify actor for the site_scrape
// waterfall method. Reads a list of company targets and, per domain, runs the
// 5-tier anti-bot fetch waterfall over the homepage + discovered contact pages,
// extracting emails / phones / socials and flagging name-matched personal emails.
//
// Input (see .actor/input_schema.json):
//   {
//     "targets": [{ "domain": "acme.com", "firstName": "Jane", "lastName": "Doe" }],
//     "maxPagesPerDomain": 6,
//     "pageKeywords": [{ "kw": "leadership", "priority": 1 }],   // optional override
//     "useProxy": false,        // residential-IP tiers (small cost)
//     "unblockerKey": ""        // managed unblocker (tier 5); absent → stop at tier 4
//   }
//
// Output: one dataset record per domain (ScrapeResult), joined back by domain in
// src/lib/apify/providers/waterfall-scrape.ts on the LeadStart side.

import { Actor } from "apify";
import { scrapeDomain, type ScrapeTarget } from "./scrape.js";
import { closeBrowser } from "./fetchPage.js";

interface Input {
  targets?: ScrapeTarget[];
  maxPagesPerDomain?: number;
  pageKeywords?: { kw: string; priority: number }[];
  useProxy?: boolean;
  unblockerKey?: string;
}

await Actor.init();

try {
  const input = ((await Actor.getInput()) as Input) ?? {};
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const maxPages = Math.max(1, Math.min(12, input.maxPagesPerDomain ?? 6));
  const unblockerKey = input.unblockerKey?.trim() || undefined;

  const proxyConfiguration = input.useProxy
    ? await Actor.createProxyConfiguration({ groups: ["RESIDENTIAL"] })
    : null;

  console.log(
    `[site-contact-scraper] ${targets.length} target(s), maxPages=${maxPages}, proxy=${!!proxyConfiguration}, unblocker=${!!unblockerKey}`,
  );

  let done = 0;
  for (const target of targets) {
    if (!target?.domain) continue;
    // A fresh proxy session per domain so one blocked IP doesn't taint the rest.
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl(`d-${done}`) : undefined;
    try {
      const result = await scrapeDomain(target, { maxPages, pageKeywords: input.pageKeywords, proxyUrl, unblockerKey });
      await Actor.pushData(result);
    } catch (err) {
      console.error(`[site-contact-scraper] ${target.domain} failed:`, err);
      await Actor.pushData({
        domain: target.domain,
        emails: [],
        companyEmails: [],
        personEmails: [],
        phones: [],
        socials: {},
        usedBrowser: false,
        fetchOutcome: "error",
        pagesFetched: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
  }
  console.log(`[site-contact-scraper] finished ${done} domain(s)`);
} finally {
  await closeBrowser();
  await Actor.exit();
}
