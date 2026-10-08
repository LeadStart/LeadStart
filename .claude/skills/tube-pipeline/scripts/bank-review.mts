// Review a bank pull (bank-pull.mjs) of cleaning businesses before import: the
// cleaning counterpart of source-review.mts. Writes source-kept.json and
// source-excluded.json in the same shape, so source-import.mts imports it.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/bank-review.mts --run <name> [--keep <id|website,...>] [--drop <id|website,...>]
//
// Rules (owner, 2026-10-08: core cleaning, janitorial AND residential):
//   - closed → dropped;
//   - main category a core cleaning type → kept;
//   - main category specialty cleaning (carpet, windows, pressure washing…) → kept,
//     tagged cleaning-specialty so enrichment can leave them out;
//   - any other main category (dry cleaners, laundry, contractors, agencies,
//     suppliers…) → dropped (it matched only through a secondary category);
//   - already in Contacts (same listing or website) → dropped; one per website.
// Each kept business carries the Scrap.io signals on its source row (booking
// software, LinkedIn page, ad pixels, site emails, franchise brand) and as tags:
// cleaning-janitorial / cleaning-residential (from its own categories; a hybrid
// gets both) or cleaning-general, booking-<platform>, franchise, has-linkedin.
// Nothing is written to LeadStart here.
import {
  ORG_ID, args, assertRepoCwd, csvList, existsSync, fmtTally, getAll, host, importRepo, join, main, readFileSync, runDir, stamp, tally, writeJson,
} from "./lib.mjs";

type Row = Record<string, any>;

const CORE = new Set(["house-cleaning-service", "janitorial-service", "cleaning-service", "commercial-cleaning-service", "maid-service", "office-cleaning-service"]);
const SPECIALTY = new Set([
  "carpet-cleaning-service", "pressure-washing-service", "window-cleaning-service", "air-duct-cleaning-service", "upholstery-cleaning-service",
  "water-damage-restoration-service", "floor-refinishing-service", "property-maintenance", "gutter-cleaning-service", "blast-cleaning-service",
  "curtain-and-upholstery-cleaning-service", "chimney-sweep", "pool-cleaning-service", "building-restorations", "fire-damage-restoration-service",
  "mold-remediation-service", "biohazard-waste-disposal-service", "crime-victim-service",
]);
// Booking-link hosts → the software the business pays for.
const BOOKING: [RegExp, string][] = [
  [/getjobber\.com$/, "jobber"], [/housecallpro\.com$/, "housecall-pro"], [/zenmaid\.com$/, "zenmaid"], [/workiz\.com$/, "workiz"],
  [/markate\.com$/, "markate"], [/(squareup\.com|square\.site)$/, "square"], [/trycents\.com$/, "cents"],
  [/(leadconnectorhq\.com|msgsndr\.com|gohighlevel\.com)$/, "gohighlevel"], [/bookingkoala\.com$/, "bookingkoala"], [/launch27\.com$/, "launch27"],
  [/servicetitan\.com$/, "servicetitan"], [/(swept\.com|sweptworks\.com)$/, "swept"], [/janitorialmanager\.com$/, "janitorial-manager"],
  [/maidcentral\.com$/, "maidcentral"], [/serviceautopilot\.com$/, "service-autopilot"], [/kickserv\.com$/, "kickserv"],
  [/servicem8\.com$/, "servicem8"], [/fieldedge\.com$/, "fieldedge"], [/calendly\.com$/, "calendly"], [/acuityscheduling\.com$/, "acuity"],
];
const FRANCHISE = /molly ?maid|merry ?maids|\bthe maids\b|jan-?pro|city ?wide|coverall|stratus ?(building|clean)|vanguard clean|servpro|servicemaster|anago|jani-?king|openworks|office ?pride|two maids|maid ?right|maidpro|cleaning authority|home ?clean ?heroes|maid ?brigade|chem-?dry|steamatic|heaven'?s best|window ?genie|fish window|men in kilts|sparkle ?team|duraclean|mr\.? ?handyman/i;
const FRANCHISE_DOMAIN = /(mollymaid|merrymaids|maids\.com|jan-pro|gocitywide|coverall|stratusclean|vanguardcleaning|servpro|servicemaster|anagocleaning|janiking|openworksweb|officepride|twomaids|maidright|maidpro|thecleaningauthority|homecleanheroes|maidbrigade|chemdry|steamatic|heavensbest|windowgenie|fishwindowcleaning)\./;

main(async () => {
  assertRepoCwd();
  const { normalizeDomain } = await importRepo("src/lib/apify/domain.ts");
  const a = args();
  const dir = runDir(a.run);
  const rawFile = join(dir, "scrapio-raw.jsonl");
  if (!existsSync(rawFile)) throw new Error(`${rawFile} not found: run bank-pull.mjs first`);
  const forceKeep = new Set(csvList(a.keep).map((s) => s.toLowerCase()));
  const forceDrop = new Set(csvList(a.drop).map((s) => s.toLowerCase()));

  const byPlace = new Map<string, { row: Row; queryCity: string; group: string }>();
  let pages = 0, stubs = 0;
  for (const line of readFileSync(rawFile, "utf8").split("\n").filter(Boolean)) {
    const j = JSON.parse(line);
    pages++;
    for (const p of j.data ?? []) {
      if (p.blacklisted === true) { stubs++; continue; }
      if (p.place_id && !byPlace.has(p.place_id)) byPlace.set(p.place_id, { row: p, queryCity: `${j.city}, ${j.state}`, group: j.group });
    }
  }

  const liveTypes = (p: Row): string[] => {
    const t = ((p.types ?? []) as Row[]).filter((x) => !x.deleted);
    const m = t.find((x) => x.is_main) ?? t[0];
    return m ? [m.type, ...t.filter((x) => x !== m).map((x) => x.type)] : [];
  };
  const label = (id: string) => id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const num = (v: unknown) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const urlHost = (u: unknown) => {
    try { return new URL(String(u)).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
  };
  const toPlace = (p: Row, group: string) => {
    const types = liveTypes(p);
    const wd = p.website_data ?? {};
    const emails = ((wd.emails ?? []) as Row[]).filter((e) => e && typeof e === "object" && e.email);
    const booking = [...new Set(((p.booking_links ?? []) as unknown[]).map(urlHost).map((h) => BOOKING.find(([re]) => re.test(h))?.[1]).filter(Boolean))] as string[];
    const domain = normalizeDomain(p.website ?? null);
    const brand = `${p.name ?? ""}`.match(FRANCHISE)?.[0] ?? (domain && FRANCHISE_DOMAIN.test(`${domain}`) ? domain : null);
    return {
      google_place_id: p.place_id,
      name: p.name ?? null,
      category: types[0] ?? null,
      category_label: types[0] ? label(types[0]) : null,
      categories: types.map(label),
      website: p.website ?? null,
      company_domain: domain,
      phone: p.phone_international ?? p.phone ?? null,
      full_address: p.location_full_address ?? null,
      street: p.location_street_1 ?? null,
      city: p.location_city ?? null,
      state: p.location_state ?? null,
      postal_code: p.location_postal_code ?? null,
      country_code: p.location_country_code ?? "US",
      latitude: num(p.location_latitude),
      longitude: num(p.location_longitude),
      rating: num(p.reviews_rating),
      reviews_count: num(p.reviews_count),
      maps_url: p.link ?? null,
      temporarily_closed: p.is_temporarily_closed === true,
      claimed: typeof p.is_claimed === "boolean" ? p.is_claimed : null,
      scrapio_emails: emails.map((e) => e.email),
      scrapio_google_id: p.google_id ?? null,
      // Signals for the later enrichment and segmenting (no employee count exists in Scrap.io).
      signals: {
        search_group: group,
        main_type: types[0] ?? null,
        booking_platforms: booking,
        booking_links: (p.booking_links ?? []).slice(0, 5),
        linkedin_url: wd.linkedin?.[0] ?? null,
        facebook_url: wd.facebook?.[0] ?? null,
        instagram_url: wd.instagram?.[0] ?? null,
        ad_pixels: wd.ad_pixels ?? [],
        site_email_count: emails.length,
        site_emails: emails.slice(0, 10).map((e) => ({ email: e.email, category: e.category ?? null, firstname: e.firstname ?? null, lastname: e.lastname ?? null, mx: e.mx_provider ?? null })),
        photos_count: p.photos_count ?? null,
        franchise_brand: brand,
        site_responding: wd.is_responding ?? null,
      },
    };
  };

  const owned = await getAll(`contacts?select=company_domain,google_place_id&organization_id=eq.${ORG_ID}&or=(company_domain.not.is.null,google_place_id.not.is.null)`);
  const ownedDomains = new Set(owned.map((r: Row) => host(r.company_domain)).filter(Boolean));
  const ownedPlaces = new Set(owned.map((r: Row) => r.google_place_id).filter(Boolean));

  type Kept = { place: ReturnType<typeof toPlace>; queryCity: string; group: string; tags: string[] };
  const excluded: Row[] = [];
  const byDomain = new Map<string, Kept>();
  const noDomain: Kept[] = [];
  const forced = (place: Row) => forceKeep.has(String(place.google_place_id).toLowerCase()) || (place.company_domain && forceKeep.has(place.company_domain));
  for (const { row, queryCity, group } of byPlace.values()) {
    const place = toPlace(row, group);
    const m = place.signals.main_type ?? "";
    const ex = (reason: string, detail?: string) =>
      excluded.push({ place_id: place.google_place_id, name: place.name ?? "", city: queryCity, domain: place.company_domain, reason, detail, place });
    if (forceDrop.has(String(place.google_place_id).toLowerCase()) || (place.company_domain && forceDrop.has(place.company_domain))) { ex("owner_dropped"); continue; }
    if (!forced(place)) {
      if (place.temporarily_closed || row.is_closed === true) { ex("closed"); continue; }
      if (!CORE.has(m) && !SPECIALTY.has(m)) { ex("off_target", `main category: ${label(m || "none")}`); continue; }
    }
    // What the business does, from its own categories (not which search found it):
    // a hybrid gets both tags; a generic "Cleaning service" only, cleaning-general.
    const types = liveTypes(row);
    const tags: string[] = [];
    if (types.some((t) => /^(house-cleaning-service|maid-service)$/.test(t))) tags.push("cleaning-residential");
    if (types.some((t) => /^(janitorial-service|commercial-cleaning-service|office-cleaning-service)$/.test(t))) tags.push("cleaning-janitorial");
    if (!tags.length) tags.push("cleaning-general");
    if (SPECIALTY.has(m)) tags.push("cleaning-specialty");
    for (const b of place.signals.booking_platforms) tags.push(`booking-${b}`);
    if (place.signals.franchise_brand) tags.push("franchise");
    if (place.signals.linkedin_url) tags.push("has-linkedin");
    const d = place.company_domain;
    if (ownedPlaces.has(place.google_place_id) && !forced(place)) { ex("already_in_contacts", "this Google listing is already a contact"); continue; }
    if (!d) { noDomain.push({ place, queryCity, group, tags }); continue; }
    if (ownedDomains.has(d) && !forced(place)) { ex("already_in_contacts", "same website as a contact we have"); continue; }
    const cur = byDomain.get(d);
    if (!cur) { byDomain.set(d, { place, queryCity, group, tags }); continue; }
    const keepNew = (place.reviews_count ?? 0) > (cur.place.reviews_count ?? 0);
    const drop = keepNew ? cur : { place, queryCity, group, tags };
    if (keepNew) byDomain.set(d, { place, queryCity, group, tags });
    excluded.push({ place_id: drop.place.google_place_id, name: drop.place.name ?? "", city: drop.queryCity, domain: d, reason: "second_office", detail: `kept ${(keepNew ? place : cur.place).name}`, place: drop.place });
  }
  const kept = [...byDomain.values(), ...noDomain];

  writeJson(join(dir, "source-kept.json"), kept.map((k) => ({ ...k.place, _query_city: k.queryCity, _group: k.group, _tags: k.tags })));
  writeJson(join(dir, "source-excluded.json"), excluded);
  const n = (f: (k: Kept) => boolean) => kept.filter(f).length;
  console.log(`Pulled pages ${pages} · stubs we already had ${stubs} · new businesses ${byPlace.size}`);
  console.log(`Kept ${kept.length} · dropped ${excluded.length}: ${fmtTally(tally(excluded.map((e) => e.reason)))}`);
  const has = (t: string) => (k: Kept) => k.tags.includes(t);
  console.log(`Kept by what they do: janitorial/commercial ${n(has("cleaning-janitorial"))} · residential ${n(has("cleaning-residential"))} (both: ${n((k) => has("cleaning-janitorial")(k) && has("cleaning-residential")(k))}) · general cleaning only ${n(has("cleaning-general"))} · specialty main category ${n(has("cleaning-specialty"))}`);
  console.log(`Signals: booking software ${n((k) => k.place.signals.booking_platforms.length > 0)} (${fmtTally(tally(kept.flatMap((k) => k.place.signals.booking_platforms)))}) · LinkedIn page ${n((k) => Boolean(k.place.signals.linkedin_url))} · franchise ${n((k) => Boolean(k.place.signals.franchise_brand))} · site emails ${n((k) => k.place.scrapio_emails.length > 0)}`);
  console.log(`Off-target main categories dropped: ${fmtTally(tally(excluded.filter((e) => e.reason === "off_target").map((e) => String(e.detail).replace("main category: ", ""))))}`);
  stamp(dir, "source_review", { kept: kept.length, excluded: excluded.length, reasons: tally(excluded.map((e) => e.reason)) });
});
