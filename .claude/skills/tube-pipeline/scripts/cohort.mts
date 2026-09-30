// A cohort = the Google-Maps firms of one or more LeadStart searches (or the
// firms whose contacts carry a tag). This module turns a cohort into TuBe's
// upload rows with the SAME code the in-app "TuBe upload" dialog runs
// (src/app/(dashboard)/admin/prospecting/tube-export-dialog.tsx: best enriched
// contact per place → buildTubeHandoff), then applies the pipeline's own
// integrity checks against the target campaign. Read-only.
import { FREE_MAIL, KEYWORD_TAIL, ORG_ID, emailDomain, emailPerson, getAll, getIn, host, importRepo, importTube, rest } from "./lib.mjs";

const { buildTubeHandoff, tubeEmailStatus, shortCompany, TUBE_SKIP_LABEL } = await importRepo("src/lib/tube/handoff.ts");
const tubeChecks = await importTube("src/lib/outreachChecks.js");

const CONTACT_COLS = [
  "id", "google_place_id", "first_name", "last_name", "email", "company_email", "company_name", "company_domain",
  "client_id", "campaign_id", "status", "tags", "email_verification_status", "email_verification_subresult",
  "email_kind:enrichment_data->enrichment->email->>kind",
  "email_provider_status:enrichment_data->enrichment->email->>provider_status",
  "email_provider:enrichment_data->enrichment->email->>provider",
  "maps_search_id:enrichment_data->>maps_search_id",
].join(",");

export async function resolveCohort({ searches = [], tag = null }: { searches?: string[]; tag?: string | null }) {
  const searchIds = new Set<string>(searches);
  let placeFilter: Set<string> | null = null;
  if (tag) {
    if (!/^[A-Za-z0-9._:-]+$/.test(tag)) throw new Error(`odd tag ${JSON.stringify(tag)}`);
    const tagged = await getAll(
      `contacts?select=google_place_id,maps_search_id:enrichment_data->>maps_search_id&organization_id=eq.${ORG_ID}&tags=cs.{${tag}}`,
    );
    if (!tagged.length) throw new Error(`no contacts carry the tag "${tag}"`);
    for (const t of tagged) if (t.maps_search_id) searchIds.add(t.maps_search_id);
    placeFilter = new Set(tagged.map((t: any) => t.google_place_id).filter(Boolean));
  }
  if (!searchIds.size) throw new Error("empty cohort: pass --searches <id,...> and/or --tag <tag>");

  const firms: any[] = [];
  const searchRows: any[] = [];
  const seenPlace = new Set<string>();
  for (const id of searchIds) {
    const [s] = await rest(`maps_searches?select=id,query,status,created_at,results&id=eq.${id}&organization_id=eq.${ORG_ID}`);
    if (!s) throw new Error(`maps search ${id} not found in this org`);
    const places = (s.results ?? []).filter(
      (p: any) => p.google_place_id && !seenPlace.has(p.google_place_id) && (!placeFilter || placeFilter.has(p.google_place_id)),
    );
    for (const p of places) seenPlace.add(p.google_place_id);
    searchRows.push({ id: s.id, query: s.query, status: s.status, created_at: s.created_at, places: places.length });
    const domainOf = new Map(places.map((p: any) => [p.google_place_id, p.company_domain || p.website]));
    const score = (c: any) => {
      const st = tubeEmailStatus(c, (domainOf.get(c.google_place_id) as string) ?? null);
      return (st === "verified" ? 3 : st === "published" ? 2 : 0) + (c.first_name ? 1 : 0);
    };
    const contacts = await getIn(
      (list: string) => `contacts?select=${CONTACT_COLS}&organization_id=eq.${ORG_ID}&google_place_id=in.${list}`,
      places.map((p: any) => p.google_place_id),
      100,
    );
    const best = new Map<string, any>();
    const all = new Map<string, any[]>();
    for (const c of contacts) {
      if (!all.has(c.google_place_id)) all.set(c.google_place_id, []);
      all.get(c.google_place_id)!.push(c);
      const prev = best.get(c.google_place_id);
      if (!prev || score(c) > score(prev)) best.set(c.google_place_id, c);
    }
    for (const p of places) {
      firms.push({
        placeName: p.name,
        categories: p.categories ?? [],
        city: p.city,
        state: p.state,
        domain: p.company_domain || p.website,
        contact: best.get(p.google_place_id) ?? null,
        contacts: all.get(p.google_place_id) ?? [],
        searchId: s.id,
      });
    }
  }
  return { firms, searches: searchRows };
}

// Why a TuBe-ready row still can't go: checked in this order, first hit wins.
export const DROP_LABEL: Record<string, string> = {
  bad_row: "Upload row is incomplete or its question is malformed",
  in_campaign: "Already enrolled in the target campaign",
  firm_in_campaign: "Same firm (website/email domain) already in the target campaign",
  other_campaign: "Active or paused in another campaign",
  emailed_before: "Already emailed by LeadStart",
  dnc: "On the do-not-contact list",
  other_client: "Belongs to another client",
  suppressed: "Contact bounced, unsubscribed or replied before",
  undeliverable: "Verifier says undeliverable",
  pooled: "Set aside as a weak email host (pooled-weak-host)",
};
export const FLAG_LABEL: Record<string, string> = {
  generic_listing_name: "Google listing name is only search words ({{firm}} will read like a keyword)",
  caps_listing_name: "Google listing name is in ALL CAPS (TuBe's export recases it; check it is the real firm name)",
  keyword_firm_name: "Firm name still ends like a search listing after TuBe's cleaner (\"… Accident & Injury Lawyers\"); validation will hold it",
  email_person_mismatch: "Email address looks like someone else's, not the owner's the email greets; validation will hold it",
  odd_first_name: "First name looks wrong (caps, initial, digits)",
  email_off_domain: "Email is on another firm-looking domain than the website (right person?)",
  published_address: "Owner address read off the firm's site on a catch-all domain (watch bounces)",
};

const REQUIRED = ["domain", "business_type", "seed_query", "markets", "company", "first_name", "email", "city", "state"];

/** The upload rows for a cohort + every row's integrity verdict against the campaign. */
/** keepDomains: firms the owner kept by hand at review; they skip the hand-off's ICP and off-vertical rules. */
export async function buildSheet(firms: any[], campaign: any, { includeGeneric = false, keepDomains = [] as string[] } = {}) {
  const h = buildTubeHandoff(firms, { includeGeneric, keepDomains });
  const firmFor = (row: any) =>
    firms.find((f) => host(f.domain) === row.domain && (f.contact?.email ?? "").trim() === row.email) ??
    firms.find((f) => host(f.domain) === row.domain);
  const rows = h.rows.map((row: any) => ({ row, firm: firmFor(row) }));
  const contacts = rows.map((r: any) => r.firm?.contact).filter(Boolean);
  const emails = contacts.map((c: any) => c.email.trim());
  const emailsAnyCase = [...new Set([...emails, ...emails.map((e: string) => e.toLowerCase())])];

  const [dnc, enrollments, sends, campEnroll] = await Promise.all([
    getIn((l: string) => `dnc_entries?select=email,client_id&organization_id=eq.${ORG_ID}&email=in.${l}`, emailsAnyCase),
    getIn((l: string) => `campaign_enrollments?select=contact_id,campaign_id,status&contact_id=in.${l}`, contacts.map((c: any) => c.id)),
    getIn((l: string) => `native_sends?select=to_email&to_email=in.${l}`, emailsAnyCase),
    getAll(`campaign_enrollments?select=contact_id&campaign_id=eq.${campaign.id}`),
  ]);
  const inCampaignContacts = await getIn(
    (l: string) => `contacts?select=id,email,company_domain&id=in.${l}`,
    campEnroll.map((e: any) => e.contact_id),
    60,
  );
  // A firm is "already in the campaign" by its website, or by its email domain
  // unless that domain is a personal mailbox provider (gmail.com is not a firm).
  const firmDomain = (d: string) => (d && !FREE_MAIL.has(d) ? d : "");
  const campaignDomains = new Set(
    inCampaignContacts.flatMap((c: any) => [host(c.company_domain), firmDomain(emailDomain(c.email))]).filter(Boolean),
  );
  const dncSet = new Set(
    dnc.filter((d: any) => d.client_id === null || d.client_id === campaign.client_id).map((d: any) => d.email.trim().toLowerCase()),
  );
  const sentSet = new Set(sends.map((s: any) => String(s.to_email).trim().toLowerCase()));
  const enrollBy = new Map<string, any[]>();
  for (const e of enrollments) {
    if (!enrollBy.has(e.contact_id)) enrollBy.set(e.contact_id, []);
    enrollBy.get(e.contact_id)!.push(e);
  }
  const genericWords = tubeChecks ? new Set([...tubeChecks.NAME_GENERIC, ...tubeChecks.NAME_FORM]) : null;

  const out = rows.map(({ row, firm }: any) => {
    const c = firm?.contact ?? {};
    const email = String(row.email).trim().toLowerCase();
    const mine = enrollBy.get(c.id) ?? [];
    const blank = REQUIRED.filter((k) => !String(row[k] ?? "").trim());
    const questionOk =
      /^Who are the best .+ in .+, [A-Z]{2}\?$/.test(row.seed_query) && row.seed_query.includes(`${row.city}, ${row.state}`);
    let drop: string | null = null;
    if (blank.length || !questionOk) drop = "bad_row";
    else if (mine.some((e) => e.campaign_id === campaign.id)) drop = "in_campaign";
    else if (campaignDomains.has(row.domain) || campaignDomains.has(firmDomain(emailDomain(row.email)))) drop = "firm_in_campaign";
    else if (mine.some((e) => e.campaign_id !== campaign.id && ["active", "paused"].includes(e.status))) drop = "other_campaign";
    else if (sentSet.has(email)) drop = "emailed_before";
    else if (dncSet.has(email)) drop = "dnc";
    else if (c.client_id && c.client_id !== campaign.client_id) drop = "other_client";
    else if (["bounced", "unsubscribed", "replied"].includes(c.status)) drop = "suppressed";
    else if (["invalid", "disposable"].includes(c.email_verification_status ?? "")) drop = "undeliverable";
    else if ((c.tags ?? []).includes("pooled-weak-host")) drop = "pooled";

    const flags: string[] = [];
    const listing = String(shortCompany(firm?.placeName ?? row.company));
    if (genericWords) {
      // A keyword listing ("Seattle Divorce Lawyers") has no word that says WHO,
      // and reads like a search phrase. An acronym (HKM, SQ) says who.
      const tokens = listing.split(/[^A-Za-z0-9']+/).filter(Boolean);
      const city = String(row.city).toLowerCase().split(/\s+/);
      const identifying = tokens.filter((t) => /^[A-Z]{2,4}$/.test(t) || !(genericWords.has(t.toLowerCase()) || city.includes(t.toLowerCase()) || t.length < 2));
      const keywordish = tokens.some((t) => city.includes(t.toLowerCase())) || /\b(lawyers|attorneys)$/i.test(listing);
      if (tokens.length && !identifying.length && keywordish) flags.push("generic_listing_name");
    }
    if (/[A-Z]{3}/.test(listing) && listing === listing.toUpperCase() && listing.replace(/[^A-Za-z]/g, "").length > 5) flags.push("caps_listing_name");
    const printed = tubeChecks ? tubeChecks.displayName(row.company, `${row.city}, ${row.state}`) : row.company;
    if (KEYWORD_TAIL.test(printed)) flags.push("keyword_firm_name");
    if (emailPerson(row.email, row.first_name, row.last_name, { city: row.city, domains: [row.domain] }) === "mismatch") flags.push("email_person_mismatch");
    const fn = String(row.first_name);
    if (/[0-9@.]/.test(fn) || fn.replace(/[^A-Za-z]/g, "").length < 2 || (fn.length > 2 && fn === fn.toUpperCase())) flags.push("odd_first_name");
    if (emailDomain(row.email) !== row.domain && !FREE_MAIL.has(emailDomain(row.email))) flags.push("email_off_domain");
    if (tubeEmailStatus(c, row.domain) === "published") flags.push("published_address");
    return { row, contactId: c.id ?? null, searchId: firm?.searchId ?? null, drop, blank, flags };
  });
  return { handoff: h, rows: out, skipLabel: TUBE_SKIP_LABEL };
}
