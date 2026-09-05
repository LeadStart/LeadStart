#!/usr/bin/env node
// Unit tests for discover.ts: pure, no network. Run: npx tsx test/discover.test.ts
import { discoverContactPages } from "../src/discover.js";

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(a: unknown, b: unknown, msg: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) pass++;
  else {
    fail++;
    failures.push(`${msg}, got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(cond: boolean, msg: string): void {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
  }
}

const home = `
<nav>
  <a href="/about-us">About Us</a>
  <a href="/services">Services</a>
  <a href="/our-team">Meet the Team</a>
  <a href="/contact">Contact</a>
  <a href="https://facebook.com/acme">Facebook</a>
  <a href="#top">Top</a>
  <a href="/">Home</a>
</nav>`;

// Priority order: contact(0) → our-team(1) → about-us(2). External + anchor + home + non-matching excluded.
eq(
  discoverContactPages(home, "https://acme.com/", { maxPages: 6 }),
  ["https://acme.com/contact", "https://acme.com/our-team", "https://acme.com/about-us"],
  "orders by priority; excludes external/anchor/home/non-matching",
);

// maxPages caps discovery (homepage counts as 1, so maxPages:2 → 1 discovered).
eq(
  discoverContactPages(home, "https://acme.com/", { maxPages: 2 }),
  ["https://acme.com/contact"],
  "maxPages:2 → only the top-priority page",
);

// Anchor-text match: path is opaque but the link text says "Leadership".
eq(
  discoverContactPages(`<a href="/p/9928">Leadership</a>`, "https://acme.com/", { maxPages: 6 }),
  ["https://acme.com/p/9928"],
  "matches via anchor text when the path is opaque",
);

// No matching links → fall back to guessing common paths.
const fb = discoverContactPages(`<a href="/pricing">Pricing</a>`, "https://acme.com/", { maxPages: 6 });
ok(fb.includes("https://acme.com/contact"), "fallback includes /contact when nav has no matches");
ok(fb.length > 0, "fallback is non-empty");

// Relative + absolute same-origin links both resolve; www vs bare host treated same-origin.
const mixed = `<a href="https://www.acme.com/contact-us">Contact</a><a href="team">Team</a>`;
eq(
  discoverContactPages(mixed, "https://acme.com/", { maxPages: 6 }),
  ["https://www.acme.com/contact-us", "https://acme.com/team"],
  "resolves absolute + relative, www treated same-origin",
);

console.log(`\ndiscover: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("\nFailures:\n" + failures.map((f) => "  ✗ " + f).join("\n"));
  process.exit(1);
}
console.log("All pass ✓");
