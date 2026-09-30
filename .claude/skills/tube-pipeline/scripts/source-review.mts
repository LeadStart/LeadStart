// Step 2: review the Scrap.io pull before anything reaches LeadStart. Read-only.
//
//   npx tsx .claude/skills/tube-pipeline/scripts/source-review.mts --run <name> [--keep <id|domain,...>] [--drop <id|domain,...>]
//
// Maps every pulled firm (<run>/scrapio-raw.jsonl) to the app's MapsPlace shape
// and applies the owner's pre-enrichment rules (2026-09-24/25), first match wins:
//   closed · a public body / nonprofit / legal aid / referral service (category
//   or name) · not a law practice (off-vertical) · large firm (national-firm
//   name or 40+ emails on its own site) · website already in Contacts · second
//   office of a firm in this pull (one lead per website; the most-reviewed
//   listing is kept).
// Writes source-kept.json (the import list) and source-excluded.json, and
// prints every judgment call (public/nonprofit, off-vertical, large) by name for
// the owner. --keep / --drop overrule single firms, by place id or website.

import {
  ORG_ID, args, assertRepoCwd, csvList, existsSync, fmtTally, getAll, host, importRepo, join, main, readFileSync, runDir, stamp, tally, writeJson,
} from "./lib.mjs";

type Row = Record<string, any>;

main(async () => {
  assertRepoCwd();
  const { normalizeDomain } = await importRepo("src/lib/apify/domain.ts");
  const { icpExclusion } = await importRepo("src/lib/tube/handoff.ts");
  const a = args();
  const dir = runDir(a.run);
  const rawFile = join(dir, "scrapio-raw.jsonl");
  if (!existsSync(rawFile)) throw new Error(`${rawFile} not found: run source-pull.mjs --pull first`);
  const forceKeep = new Set(csvList(a.keep).map((s) => s.toLowerCase()));
  const forceDrop = new Set(csvList(a.drop).map((s) => s.toLowerCase()));

  // ── raw rows (a re-run pull appends; the first copy of a place wins) ──
  const byPlace = new Map<string, { row: Row; queryCity: string; group: string }>();
  let pages = 0, stubs = 0;
  for (const line of readFileSync(rawFile, "utf8").split("\n").filter(Boolean)) {
    const j = JSON.parse(line);
    pages++;
    for (const p of j.data ?? []) {
      if (p.blacklisted === true) { stubs++; continue; }
      if (p.place_id && !byPlace.has(p.place_id)) byPlace.set(p.place_id, { row: p, queryCity: j.city, group: j.group });
    }
  }

  // ── Scrap.io row → MapsPlace (what importMapsPlaces takes) ──
  const liveTypes = (p: Row): string[] => {
    const t = ((p.types ?? []) as Row[]).filter((x) => !x.deleted);
    const main = t.find((x) => x.is_main) ?? t[0];
    return main ? [main.type, ...t.filter((x) => x !== main).map((x) => x.type)] : [];
  };
  const label = (id: string) => id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  const num = (v: unknown) => (v !== null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
  const emailsOf = (p: Row): string[] =>
    ((p.website_data?.emails ?? []) as unknown[]).map((e) => (typeof e === "string" ? e : (e as Row)?.email)).filter(Boolean) as string[];
  const toPlace = (p: Row) => {
    const types = liveTypes(p);
    return {
      google_place_id: p.place_id,
      name: p.name ?? null,
      category: types[0] ?? null,
      category_label: types[0] ? label(types[0]) : null,
      categories: types.map(label),
      website: p.website ?? null,
      company_domain: normalizeDomain(p.website ?? null),
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
      scrapio_emails: emailsOf(p),
      scrapio_google_id: p.google_id ?? null,
    };
  };

  // ── the owner's rules ──
  const LAW_TYPE = /attorney|lawyer|law-firm|legal-services/;
  const PUBLIC_MAIN = /district-attorney|attorney-referral-service|legal-aid-office|lawyers-association|legal-affairs-bureau|non-profit|nonprofit|government|public-defender|courthouse|charity|city-hall|police|^court/;
  const PUBLIC_ANY = /non-profit|nonprofit|government-office|public-defender|courthouse|charity|district-attorney|legal-affairs-bureau|lawyers-association/;
  // Google gives some private firms odd categories ("Government office"), so a
  // category marks a public body only when the name doesn't show a private firm.
  const PRIVATE_NAME = /\b(pllc|p\.?\s?s\.?|p\.?\s?c\.?|llp|llc|inc\.?|ltd\.?)(\b|$)|law firm|law offices?|attorneys? at law|& associates|\blawyers?\b|legal group|law group/i;
  const LAW_NAME = /\blaw\b|attorney|lawyer|legal|esq|counsel|advocat/i;
  const owned = await getAll(`contacts?select=company_domain,google_place_id&organization_id=eq.${ORG_ID}&or=(company_domain.not.is.null,google_place_id.not.is.null)`);
  const ownedDomains = new Set(owned.map((r: Row) => host(r.company_domain)).filter(Boolean));
  const ownedPlaces = new Set(owned.map((r: Row) => r.google_place_id).filter(Boolean));

  type Kept = { place: ReturnType<typeof toPlace>; queryCity: string; group: string };
  const excluded: Row[] = [];
  const byDomain = new Map<string, Kept>();
  const noDomain: Kept[] = [];
  const forced = (place: Row) => forceKeep.has(String(place.google_place_id).toLowerCase()) || (place.company_domain && forceKeep.has(place.company_domain));
  for (const { row, queryCity, group } of byPlace.values()) {
    const place = toPlace(row);
    const types = liveTypes(row);
    const main = types[0] ?? "";
    const ex = (reason: string, detail?: string) =>
      excluded.push({ place_id: place.google_place_id, name: place.name ?? "", city: queryCity, domain: place.company_domain, reason, detail, place });
    const name = place.name ?? "";
    if (forceDrop.has(String(place.google_place_id).toLowerCase()) || (place.company_domain && forceDrop.has(place.company_domain))) { ex("owner_dropped"); continue; }
    if (!forced(place)) {
      if (place.temporarily_closed || row.is_closed === true) { ex("closed"); continue; }
      const commercial = Boolean(place.company_domain) && !/\.(org|gov|edu|us)$/.test(place.company_domain!);
      const privateFirm = PRIVATE_NAME.test(name) || (/\blaw\b|legal/i.test(name) && commercial);
      if (PUBLIC_MAIN.test(main) && !privateFirm) { ex("public_or_nonprofit", `main category: ${label(main)}`); continue; }
      const pubType = types.find((t) => PUBLIC_ANY.test(t));
      if (pubType && !privateFirm) { ex("public_or_nonprofit", `category: ${label(pubType)}`); continue; }
      const lawMain = LAW_TYPE.test(main) && !PUBLIC_MAIN.test(main);
      const lawSecondary = types.slice(1).some((t) => LAW_TYPE.test(t) && !PUBLIC_MAIN.test(t));
      if (!lawMain && !(lawSecondary && LAW_NAME.test(name))) { ex("off_vertical", `main category: ${label(main || "none")}`); continue; }
      let icp = icpExclusion(place.name, place.company_domain, []);
      // "… Law Center" on a .com is a private firm; re-check without that term.
      if (icp === "public_or_nonprofit" && commercial && /law center/i.test(name)
        && icpExclusion(name.replace(/law center/gi, "Law Firm"), place.company_domain, []) === null) icp = null;
      if (icp) { ex(icp, `name/website rule (${place.company_domain ?? "no website"})`); continue; }
      const own = place.company_domain ? place.scrapio_emails.filter((e) => e.toLowerCase().endsWith(`@${place.company_domain}`)).length : 0;
      if (own >= 40) { ex("large_firm", `${own} emails on its own site`); continue; }
    }
    const d = place.company_domain;
    if (ownedPlaces.has(place.google_place_id) && !forced(place)) { ex("already_in_contacts", "this Google listing is already a contact"); continue; }
    if (!d) { noDomain.push({ place, queryCity, group }); continue; }
    if (ownedDomains.has(d) && !forced(place)) { ex("already_in_contacts", "same website as a contact we have"); continue; }
    const cur = byDomain.get(d);
    if (!cur) { byDomain.set(d, { place, queryCity, group }); continue; }
    const keepNew = (place.reviews_count ?? 0) > (cur.place.reviews_count ?? 0);
    const drop = keepNew ? cur : { place, queryCity, group };
    if (keepNew) byDomain.set(d, { place, queryCity, group });
    excluded.push({ place_id: drop.place.google_place_id, name: drop.place.name ?? "", city: drop.queryCity, domain: d, reason: "second_office", detail: `kept ${(keepNew ? place : cur.place).name}`, place: drop.place });
  }
  const kept = [...byDomain.values(), ...noDomain];

  // ── outputs + the owner's review list ──
  writeJson(join(dir, "source-kept.json"), kept.map((k) => ({ ...k.place, _query_city: k.queryCity, _group: k.group })));
  writeJson(join(dir, "source-excluded.json"), excluded);
  const med = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  console.log(`Pulled pages ${pages} · firms we already had (free stubs) ${stubs} · new firms ${byPlace.size}`);
  console.log(`Kept ${kept.length}${noDomain.length ? ` (${noDomain.length} without a usable website)` : ""} · dropped ${excluded.length}: ${fmtTally(tally(excluded.map((e) => e.reason)))}`);
  console.log(`Kept by city: ${fmtTally(tally(kept.map((k) => k.queryCity)))}`);
  console.log(`Kept by main category: ${fmtTally(tally(kept.map((k) => k.place.category_label ?? "?")))}`);
  console.log(`Kept median reviews ${med(kept.map((k) => k.place.reviews_count ?? NaN))} · with emails on their own site ${kept.filter((k) => k.place.scrapio_emails.length).length}/${kept.length}`);
  for (const r of ["public_or_nonprofit", "large_firm", "off_vertical", "owner_dropped"]) {
    const xs = excluded.filter((e) => e.reason === r);
    if (xs.length) console.log(`\n${r} (${xs.length}): the owner can keep any with --keep <place id or website>\n` + xs.map((e) => `  ✗ ${e.name} · ${e.city} · ${e.domain ?? "no website"} · ${e.detail ?? ""}`).join("\n"));
  }
  stamp(dir, "source_review", { new_firms: byPlace.size, kept: kept.length, dropped: excluded.length, dropped_by_reason: tally(excluded.map((e) => e.reason)), forced_keep: forceKeep.size, forced_drop: forceDrop.size, kept_by_hand: [...forceKeep], dropped_by_hand: [...forceDrop] });

});
