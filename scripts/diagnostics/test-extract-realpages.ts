// Validate the hardened extractContacts against the exact real pages that produced
// garbage in the smoke test (tier-1 plain fetch only — no browser, no Apify, no
// prod writes). Run: npx tsx scripts/diagnostics/test-extract-realpages.ts
import { extractContacts } from "../../apify-actors/site-contact-scraper/src/extract.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const targets = [
  { url: "https://www.gnu.org/", domain: "gnu.org", first: undefined, last: undefined },
  { url: "https://www.gnu.org/contact/", domain: "gnu.org", first: undefined, last: undefined },
  { url: "https://apify.com/contact", domain: "apify.com", first: "Jan", last: "Curn" },
];

async function main() {
  for (const t of targets) {
    try {
      const res = await fetch(t.url, { headers: { "user-agent": UA }, redirect: "follow" });
      const html = await res.text();
      const c = extractContacts(html, { firstName: t.first, lastName: t.last }, t.domain);
      console.log(`\n▶ ${t.url}  (HTTP ${res.status}, ${html.length} bytes)`);
      console.log(`  phones(${c.phones.length}): ${c.phones.slice(0, 8).join(", ")}`);
      console.log(`  companyEmails(${c.companyEmails.length}): ${c.companyEmails.slice(0, 8).join(", ")}`);
      console.log(
        `  personEmails(${c.personEmails.length}): ${c.personEmails.slice(0, 8).map((p) => p.email + (p.nameMatched ? "*" : "")).join(", ")}`,
      );
    } catch (err) {
      console.log(`\n▶ ${t.url}  FETCH FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
main();
