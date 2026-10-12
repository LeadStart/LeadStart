#!/usr/bin/env node
/**
 * Drives the REAL decision-maker Layer 1 (src/lib/decision-maker/layer1.ts +
 * fetcher.ts) against a stubbed network, to prove the owner named on a site's
 * about page reaches the model:
 *   - a long homepage (over 12,000 chars of text) links to an about page that
 *     says "Jane Doe, Owner"; the prompt sent to Claude Haiku must carry that
 *     line. Until 2026-10-11 the pages were joined homepage-first and cut at
 *     12,000 chars, so it never did (owners on 4 of 131 audited cleaning sites
 *     were missed this way).
 *   - two long subpages share the budget: an owner named deep in either still
 *     reaches the prompt
 *   - htmlToText strips tags of any length (the old /<[^>]{0,500}>/ strip leaked
 *     Elementor data-settings and srcset lists into the prompt), and reads a page
 *     whose <body> starts after hundreds of KB of inline CSS
 *   - extractEmails stays one pass on a long run with no "@" (pages can now be
 *     2 MB; the old scan was quadratic there)
 *   - findContactPages reads about/team pages before contact pages, a page linked
 *     with and without a #fragment once, and careers pages last
 *   - pages are requested with a full Chrome User-Agent and browser Accept /
 *     Accept-Language headers; a host that 403s a bare UA serves the page
 *   - through enrichBusiness with a 2 s limit, the subpages load together and a
 *     page that never answers is cut off when the fetch window (half the limit)
 *     closes, so the lookup finishes in time with the about page; one after
 *     another they ran past the limit and the whole lookup was lost
 *
 * globalThis.fetch is stubbed: the sites are served from memory, and the
 * Anthropic call is answered by a fake model that can only name a person whose
 * name appears in the prompt it was sent. No network, no API key, no cost.
 *
 * Run: npx tsx scripts/test-decision-maker-layer1.ts
 */
import { enrichWithWebsite } from "../src/lib/decision-maker/layer1.ts";
import { enrichBusiness } from "../src/lib/decision-maker/index.ts";
import { htmlToText, findContactPages } from "../src/lib/decision-maker/fetcher.ts";
import { extractEmails } from "../src/lib/decision-maker/validation.ts";
import type { EnrichmentInput, EnrichmentOptions } from "../src/lib/decision-maker/types.ts";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(cond: boolean, msg: string, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  ✗ ${msg}${detail ? `\n      ${detail}` : ""}`);
  }
}
function eq<T>(got: T, want: T, msg: string) {
  ok(got === want, msg, `got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
}

// ---------------------------------------------------------------- fake sites

const nav = (links: [string, string][]) =>
  `<header><nav class="elementor-nav-menu"><ul>${links
    .map(([href, label]) => `<li class="menu-item"><a href="${href}" class="elementor-item">${label}</a></li>`)
    .join("")}</ul></nav></header>`;
const page = (title: string, body: string, head = "") =>
  `<!doctype html><html><head><title>${title}</title>${head}<script>window.dataLayer=[];</script></head><body>${body}<footer><p>&copy; 2026 All rights reserved.</p></footer></body></html>`;
// About 220 chars of text per section; nobody is named in it.
const filler = (n: number, topic: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<section class="elementor-section"><h2>${topic} ${i + 1}</h2><p>We clean homes and offices across Springfield: weekly, biweekly and one-time visits, deep cleans, move-out cleans and post-construction cleanup, with eco-friendly products and a happiness guarantee.</p></section>`,
  ).join("\n");
// Elementor writes widget settings as one long data-* attribute; this one runs past 500 chars.
const elementorSettings = `{&quot;_animation&quot;:&quot;fadeInUp&quot;,${Array.from({ length: 24 }, (_, i) => `&quot;setting_${i}&quot;:&quot;value_${i}&quot;`).join(",")}}`;
const srcset = Array.from({ length: 14 }, (_, i) => `/wp-content/uploads/2024/05/jane-doe-${300 + i * 60}x${300 + i * 60}.jpg ${300 + i * 60}w`).join(", ");

const SITE_NAV: [string, string][] = [
  ["/", "Home"],
  ["/services/", "Services"],
  ["/contact/#quote-form", "Get a Quote"],
  ["/contact/", "Contact"],
  ["/about-us/", "About Us"],
  ["/careers/", "Join Our Team"],
];

const HOME_HTML = page(
  "Acme Cleaning Co | House Cleaning in Springfield",
  `${nav(SITE_NAV)}<main><h1>Spotless homes, happy families.</h1>${filler(90, "Service area")}</main>`,
);
const ABOUT_HTML = page(
  "About Us | Acme Cleaning Co",
  `${nav(SITE_NAV)}<main>
    <div class="elementor-element elementor-widget-heading" data-id="5f2c1a9" data-settings="${elementorSettings}" data-widget_type="heading.default">
      <h2 class="elementor-heading-title">Meet the Owner</h2>
    </div>
    <img src="/wp-content/uploads/2024/05/jane-doe.jpg" srcset="${srcset}" sizes="(max-width: 640px) 100vw, 241px" alt="portrait">
    <p>Jane Doe, Owner</p>
    <p>Jane started Acme Cleaning Co in 2009. Our rates start at $&amp; up, the same in every {city} we serve.</p>
  </main>`,
);
const CONTACT_HTML = page(
  "Contact | Acme Cleaning Co",
  `${nav(SITE_NAV)}<main><p>Call (217) 555-0142 or email info@acme-cleaning.test. Our office hours are Monday to Friday, 8am to 5pm.</p></main>`,
);
const CAREERS_HTML = page(
  "Careers | Acme Cleaning Co",
  `${nav(SITE_NAV)}<main><p>We are hiring house cleaners in Springfield.</p></main>`,
);

// Two long people pages: each names someone ~6,000 chars in.
const TEAM_NAV: [string, string][] = [["/our-team/", "Our Team"], ["/our-story/", "Our Story"], ["/contact-us/", "Contact Us"]];
const BRIGHT_HOME = page("Bright Maids", `${nav(TEAM_NAV)}<main>${filler(70, "Why Bright Maids")}</main>`);
const BRIGHT_TEAM = page(
  "Our Team | Bright Maids",
  `${nav(TEAM_NAV)}<main>${filler(27, "Crew")}<p>Robert Smith, President</p>${filler(40, "Crew")}</main>`,
);
const BRIGHT_STORY = page(
  "Our Story | Bright Maids",
  `${nav(TEAM_NAV)}<main>${filler(27, "Chapter")}<p>Carol King, Founder</p>${filler(40, "Chapter")}</main>`,
);
const BRIGHT_CONTACT = page("Contact | Bright Maids", `${nav(TEAM_NAV)}<main><p>Write to us any time.</p></main>`);

// A site-builder page: ~300 KB of inline CSS in <head> before <body> opens.
const BUILDER_HOME = page(
  "Sparkle Co",
  `<main><p>Family owned since 1998.</p><p>Maria Lopez, Owner</p></main>`,
  `<style>${".c{color:#123456;margin:0 auto;padding:4px}\n".repeat(7_000)}</style>`,
);

// A slow host: subpages take 300 ms each and the careers page never answers.
const SLOW_NAV: [string, string][] = [["/about-us/", "About Us"], ["/our-team/", "Our Team"], ["/contact/", "Contact"], ["/careers/", "Join Our Team"]];
const SLOW_SITE = {
  "https://slow-host.test/": page("Slow Host Cleaning", `${nav(SLOW_NAV)}<main><p>Commercial cleaning in Springfield.</p></main>`),
  "https://slow-host.test/about-us/": page("About | Slow Host Cleaning", `${nav(SLOW_NAV)}<main><p>Dana Reyes, Owner</p></main>`),
  "https://slow-host.test/our-team/": page("Team | Slow Host Cleaning", `${nav(SLOW_NAV)}<main><p>Our crew leads have 10+ years each.</p></main>`),
  "https://slow-host.test/contact/": page("Contact | Slow Host Cleaning", `${nav(SLOW_NAV)}<main><p>Call (217) 555-0199 any weekday.</p></main>`),
  "https://slow-host.test/careers/": page("Careers | Slow Host Cleaning", `${nav(SLOW_NAV)}<main><p>NEVER-SERVED careers text.</p></main>`),
  "https://slow-home.test/": page("Slow Home Cleaning", `${nav(SLOW_NAV)}<main><p>Owned by Lee Park, Owner.</p></main>`),
};
// Response delay per page, in ms; Infinity = never answers (until aborted).
const DELAYS: Record<string, number> = {
  "https://slow-host.test/": 50,
  "https://slow-host.test/about-us/": 300,
  "https://slow-host.test/our-team/": 300,
  "https://slow-host.test/contact/": 300,
  "https://slow-host.test/careers/": Infinity,
  "https://slow-home.test/": 300,
};
const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) return abort();
    const timer = ms === Infinity ? null : setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      if (timer) clearTimeout(timer);
      abort();
    }, { once: true });
  });

const SITES: Record<string, string> = {
  ...SLOW_SITE,
  "https://acme-cleaning.test/": HOME_HTML,
  "https://acme-cleaning.test/about-us/": ABOUT_HTML,
  "https://acme-cleaning.test/contact/": CONTACT_HTML,
  "https://acme-cleaning.test/careers/": CAREERS_HTML,
  "https://bright-maids.test/": BRIGHT_HOME,
  "https://bright-maids.test/our-team/": BRIGHT_TEAM,
  "https://bright-maids.test/our-story/": BRIGHT_STORY,
  "https://bright-maids.test/contact-us/": BRIGHT_CONTACT,
  "https://sparkle-co.test/": BUILDER_HOME,
  "https://strict-host.test/": page("Strict Host Cleaning", `<main><p>Owned and operated by Ken Adams, Owner.</p></main>`),
};

// ---------------------------------------------------------------- stubbed network

const pageRequests: { url: string; headers: Headers; at: number }[] = [];
let lastPrompt = "";
const KNOWN_PEOPLE = ["Jane Doe", "Robert Smith", "Carol King", "Maria Lopez", "Ken Adams", "Dana Reyes", "Lee Park"];

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(raw);
  if (url.pathname.endsWith("/v1/messages")) {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { content: string }[] };
    lastPrompt = body.messages[0].content;
    // The fake model can only name someone whose name is in the prompt it got.
    const seen = KNOWN_PEOPLE.find((n) => lastPrompt.includes(n));
    const [first_name, last_name] = seen ? seen.split(" ") : ["", ""];
    const answer = { first_name, last_name, title: seen ? "Owner" : "", email: "" };
    return new Response(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: JSON.stringify(answer) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  const headers = new Headers(init?.headers);
  pageRequests.push({ url: url.href, headers, at: performance.now() });
  url.hash = "";
  if (DELAYS[url.href]) await sleep(DELAYS[url.href], init?.signal);
  // A host-firewall rule seen on real nginx hosts: no Chrome token in the UA → 403.
  if (url.hostname === "strict-host.test" && !/Chrome\/\d+/.test(headers.get("user-agent") ?? "")) {
    return new Response("Forbidden", { status: 403 });
  }
  const html = SITES[url.href];
  return html === undefined
    ? new Response("Not found", { status: 404 })
    : new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}) as typeof fetch;
delete process.env.ANTHROPIC_BASE_URL;

const OPTS: EnrichmentOptions = { serviceType: "operations", useLayer2: false, anthropicKey: "test-key-not-real" };
const inputFor = (business_name: string, website: string): EnrichmentInput => ({
  business_name,
  website,
  category: "House cleaning service",
  city: "Springfield",
  state: "IL",
  generic_email: null,
});
// The {page_text} part of the Layer 1 prompt.
const pageTextOf = (prompt: string) => prompt.slice(prompt.indexOf("Website text:") + "Website text:".length);
// Run Layer 1 with the captured prompt cleared first, so a run that never
// reaches the model can't be checked against the previous run's prompt.
const runLayer1 = (business_name: string, website: string) => {
  lastPrompt = "";
  return enrichWithWebsite(inputFor(business_name, website), OPTS);
};

async function main(): Promise<void> {
  console.log("htmlToText: tags of any length, whole pages, entities");
  const aboutText = htmlToText(ABOUT_HTML);
  ok(aboutText.includes("Jane Doe, Owner"), "about page text keeps the owner line");
  ok(!/data-settings|data-widget_type|srcset|wp-content|elementor/.test(aboutText), "no attribute junk from tags over 500 chars", aboutText.slice(0, 300));
  eq(htmlToText(`<div data-x="${"y".repeat(600)}">Jane Doe</div>`), "Jane Doe", "a 600-char attribute is stripped with its tag");
  eq(htmlToText(`<div data-show-if="width > 768">Owner</div>`), "Owner", "a '>' inside a quoted attribute does not end the tag");
  eq(htmlToText("<!-- <p>old menu</p> --><p>Visible</p>"), "Visible", "comments are dropped, markup inside them too");
  eq(htmlToText("<script>var a = '<p>x</p>';</script><style>p{color:red}</style><p>Hi</p>"), "Hi", "script and style blocks are dropped");
  eq(htmlToText("<p>Jos&eacute; Garc&iacute;a &amp; O&#8217;Brien &lt;owners&gt;</p>"), "José García & O’Brien <owners>", "named, accented and numeric entities decode");
  eq(htmlToText("<p>a < b and c</p>"), "a < b and c", "a bare '<' in text stays text");
  ok(htmlToText(BUILDER_HOME).includes("Maria Lopez, Owner"), "a page with ~300 KB of inline CSS before <body> still yields its body text");

  console.log("\nextractEmails: one pass, however long a run with no '@'");
  const started = performance.now();
  const emails = extractEmails(`<svg><path d="M${"1".repeat(200_000)}"/></svg> Email jane.doe@acme-cleaning.test`);
  const tookMs = performance.now() - started;
  eq(JSON.stringify(emails), JSON.stringify(["jane.doe@acme-cleaning.test"]), "finds the address after a 200,000-char run");
  ok(tookMs < 1_000, `in well under a second (${tookMs.toFixed(0)} ms; a per-character rescan takes ~20 s here)`);

  console.log("\nfindContactPages: people pages first, each page once, careers last");
  const links = findContactPages(HOME_HTML, "https://acme-cleaning.test").map((u) => new URL(u).pathname + new URL(u).hash);
  eq(links[0], "/about-us/", "the about page is read first");
  eq(links.filter((p) => p.startsWith("/contact/")).length, 1, "the contact page is read once, though linked with and without #quote-form");
  eq(links[links.length - 1], "/careers/", "the careers page ('Join Our Team') comes last");
  eq(JSON.stringify(links), JSON.stringify(["/about-us/", "/contact/", "/careers/"]), "exactly about, contact, careers");
  const noisy = `<a href="/steam-cleaning/">Steam Cleaning</a><a href="/for-homeowners/">Homeowners</a><a href="/schedule-a-meeting/">Book</a><a href="/#about">About</a><a href="/services/">Trusted Professionals Skilled team backs cleaning services.</a><a href="/meet-the-owner/">Our Founder</a>`;
  eq(JSON.stringify(findContactPages(noisy, "https://x.test/").map((u) => new URL(u).pathname)), JSON.stringify(["/meet-the-owner/"]), "steam/homeowners/meeting/same-page/content-card links are not people pages");

  console.log("\nenrichWithWebsite: a long homepage no longer pushes the about page out of the prompt");
  ok(htmlToText(HOME_HTML).length > 12_000, `the homepage alone is over 12,000 chars of text (${htmlToText(HOME_HTML).length})`);
  pageRequests.length = 0;
  const acme = await runLayer1("Acme Cleaning Co", "https://acme-cleaning.test");
  const acmeText = pageTextOf(lastPrompt);
  ok(acmeText.includes("Jane Doe, Owner"), 'the about page\'s "Jane Doe, Owner" reaches the prompt');
  eq(`${acme.first_name} ${acme.last_name}`, "Jane Doe", "so the owner is named");
  ok(acmeText.includes("Spotless homes, happy families."), "the homepage still leads the prompt (trimmed, not dropped)");
  ok(acmeText.includes("Our office hours are Monday to Friday"), "the contact page reaches the prompt too");
  ok(acmeText.includes("We are hiring house cleaners"), "and the careers page");
  ok(acmeText.includes("$& up, the same in every {city} we serve"), "page text reaches the model as written ($& and {city} stay literal)");
  ok(!/data-settings|srcset|elementor/.test(acmeText), "no markup reaches the prompt");
  ok(acmeText.length <= 20_500, `the page text stays within the budget (${acmeText.length} chars)`);
  ok(acme.enrichment_notes.startsWith("Scraped 4 pages"), `home + 3 subpages fetched once each (${acme.enrichment_notes})`);

  console.log("\nrequests look like a browser");
  const ua = pageRequests[0]?.headers.get("user-agent") ?? "";
  ok(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/.test(ua), `full Chrome User-Agent (${ua})`);
  ok((pageRequests[0]?.headers.get("accept") ?? "").startsWith("text/html,application/xhtml+xml,application/xml;q=0.9"), "browser Accept header");
  ok((pageRequests[0]?.headers.get("accept-language") ?? "").startsWith("en-US"), "Accept-Language is sent");
  const strict = await runLayer1("Strict Host Cleaning", "https://strict-host.test");
  eq(`${strict.first_name} ${strict.last_name}`, "Ken Adams", "a host that 403s a bare User-Agent serves the page");

  console.log("\ntwo long subpages share the budget");
  const bright = await runLayer1("Bright Maids", "https://bright-maids.test");
  const brightText = pageTextOf(lastPrompt);
  ok(htmlToText(BRIGHT_TEAM).indexOf("Robert Smith") > 5_000, "the team page names its president over 5,000 chars in");
  ok(brightText.includes("Robert Smith, President"), "the team page's president reaches the prompt");
  ok(brightText.includes("Carol King, Founder"), "the story page's founder reaches the prompt");
  ok(bright.enrichment_notes.startsWith("Scraped 4 pages"), `home + team + story + contact (${bright.enrichment_notes})`);

  console.log("\na page built after ~300 KB of inline CSS");
  const sparkle = await runLayer1("Sparkle Co", "https://sparkle-co.test");
  eq(`${sparkle.first_name} ${sparkle.last_name}`, "Maria Lopez", "the owner named in its body is found");

  console.log("\nenrichBusiness with a 2 s limit: subpages load together, a page that never answers is cut off");
  pageRequests.length = 0;
  lastPrompt = "";
  const startedAt = performance.now();
  const slow = await enrichBusiness(inputFor("Slow Host Cleaning", "https://slow-host.test"), {
    ...OPTS,
    perBusinessTimeoutMs: 2_000,
  });
  const slowMs = performance.now() - startedAt;
  eq(slow.status, "complete", `the lookup finishes instead of timing out (${slow.enrichment_notes})`);
  ok(slowMs < 2_000, `inside the 2 s limit (${slowMs.toFixed(0)} ms)`);
  eq(`${slow.first_name} ${slow.last_name}`, "Dana Reyes", "the about page's owner is named");
  const subStarts = pageRequests.filter((r) => new URL(r.url).pathname !== "/").map((r) => r.at);
  const spread = subStarts.length ? Math.max(...subStarts) - Math.min(...subStarts) : Infinity;
  eq(subStarts.length, 4, "all 4 subpages are requested");
  ok(spread < 100, `at once, not one after another (first to last start: ${spread.toFixed(0)} ms)`);
  ok(slow.enrichment_notes.startsWith("Scraped 4 pages"), "the 3 pages that answered are read; the one that never did is dropped");
  ok(!lastPrompt.includes("NEVER-SERVED"), "nothing from the page that never answered");

  console.log("\na homepage that uses up the fetch window leaves the subpages unrequested");
  pageRequests.length = 0;
  const slowHome = await enrichBusiness(inputFor("Slow Home Cleaning", "https://slow-home.test"), {
    ...OPTS,
    perBusinessTimeoutMs: 1_200,
  });
  eq(pageRequests.length, 1, "only the homepage is requested (300 ms of a 600 ms window, under 500 ms left)");
  eq(`${slowHome.first_name} ${slowHome.last_name}`, "Lee Park", "the homepage's owner is still named");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("All pass ✓");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
