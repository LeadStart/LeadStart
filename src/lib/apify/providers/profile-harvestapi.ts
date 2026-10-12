import { extractProfileId, normalizeCompanyName, sanitizeCompanyUrl } from "../domain";
import { lc, trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

export const PROFILE_ACTOR_ID = "harvestapi~linkedin-profile-scraper";
export const PROFILE_SCRAPER_MODE = "Profile details + email search ($10 per 1k)";

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The exact email field name is not documented: pin on the first live call.
// Until then, scan the common shapes defensively. `verified` is the actor's own
// SMTP-validation signal: provider-local, kept only to nudge our stored
// confidence. Million Verifier is the authority that gates the actual send.
// `free` is the actor's own personal-mailbox flag (on an `emails[]` entry: read
// off run ac01fd98), null when the shape carries none.
function pickEmail(rec: Rec): { email: string | null; verified: boolean; free: boolean | null } {
  let email =
    str(rec.email) ??
    str(rec.workEmail) ??
    str(rec.professionalEmail) ??
    str(rec.emailAddress) ??
    str((rec.contactInfo as Rec | undefined)?.email);

  let free: boolean | null = null;
  if (!email && Array.isArray(rec.emails) && rec.emails.length > 0) {
    const first = rec.emails[0];
    email = typeof first === "string" ? first.trim() : str((first as Rec)?.email);
    if (first && typeof first === "object" && typeof (first as Rec).free === "boolean") free = (first as Rec).free as boolean;
  }
  if (!email) return { email: null, verified: false, free: null };

  const statusRaw =
    str(rec.emailStatus) ??
    str((rec.emailVerification as Rec | undefined)?.status) ??
    str(rec.email_status) ??
    "";
  const verified = /valid|deliverable|verified|safe/i.test(statusRaw);
  return { email, verified, free };
}

// Positions, as this actor returns them (read off run ac01fd98's dataset,
// 2026-10-11): `currentPosition[]` holds only the role LinkedIn shows first, often
// a side job (10 of 65 there, e.g. "Realtor" for a cleaning firm's founder);
// `experience[]` lists every role, a current one ending `{ text: "Present" }`. The
// job title is `position` (the people-search actor's export calls it `title`).
function positionTitle(p: Rec): string | null {
  return str(p.position) ?? str(p.title);
}

function isCurrentRole(p: Rec): boolean {
  const end = p.endDate;
  if (end == null) return true;
  if (typeof end === "string") return /present/i.test(end);
  const text = str((end as Rec).text);
  return text ? /present/i.test(text) : (end as Rec).year == null;
}

// Every current role: the listed ones first, then each experience entry ending "Present".
function currentRoles(rec: Rec): Rec[] {
  const listed = Array.isArray(rec.currentPosition)
    ? rec.currentPosition
    : Array.isArray(rec.currentPositions)
      ? rec.currentPositions
      : [];
  const fromExperience = Array.isArray(rec.experience) ? (rec.experience as Rec[]).filter(isCurrentRole) : [];
  return [...(listed as Rec[]), ...fromExperience].filter((p) => p && typeof p === "object");
}

// "ABS Commercial Cleaning, LLC", "ABS Commercial Cleaning" and "A.B.S. Commercial-
// Cleaning" are one company; so are "Bright & Clean" and "Bright and Clean".
function companyKey(name: string | null | undefined): string {
  return normalizeCompanyName(name?.replace(/&/g, " and ")).replace(/[^a-z0-9]/g, "");
}

// The person's current roles at the contact's own company (none without a name).
function rolesAtCompany(rec: Rec, companyName: string | null): Rec[] {
  const want = companyKey(companyName);
  return want ? currentRoles(rec).filter((p) => companyKey(str(p.companyName)) === want) : [];
}

// The person's job title: their current role at the contact's company, else
// their first current role. Null when the profile lists no current role.
export function pickCurrentTitle(
  rec: Rec,
  companyName: string | null,
): { title: string; company: string | null; matchedCompany: boolean } | null {
  const hit = rolesAtCompany(rec, companyName).find((p) => positionTitle(p));
  const pos = hit ?? currentRoles(rec).find((p) => positionTitle(p));
  if (!pos) return null;
  return { title: positionTitle(pos)!, company: str(pos.companyName), matchedCompany: Boolean(hit) };
}

// The company page the domains phase turns into the contact's company domain:
// the one on their role at the contact's own company. When that role has no page
// (the actor then gives a search link), none: any other role's page is another
// employer, whose domain the waterfall would then guess and mail (run ac01fd98:
// two cleaning-firm owners got their side job's domain, one an email there). With
// no role at the contact's company, the first page listed, as before.
export function pickCompanyLinkedinUrl(rec: Rec, companyName: string | null): string | null {
  const own = rolesAtCompany(rec, companyName);
  const positions =
    (own.length > 0 && own) ||
    (Array.isArray(rec.currentPosition) && rec.currentPosition) ||
    (Array.isArray(rec.currentPositions) && rec.currentPositions) ||
    (Array.isArray(rec.experience) && rec.experience) ||
    [];
  for (const p of positions as Rec[]) {
    // Real /company/ page only: a search-link placeholder is not a company URL.
    const url = sanitizeCompanyUrl(str(p?.companyLinkedinUrl) ?? str(p?.companyUrl));
    if (url) return url;
  }
  return null;
}

export const profileProvider: PhaseProvider = {
  id: "harvestapi",
  actorId: PROFILE_ACTOR_ID,

  buildInput(items: ProviderItem[]): unknown {
    const urls = items
      .map((it) => it.linkedin_url)
      .filter((u): u is string => Boolean(u));
    return { profileScraperMode: PROFILE_SCRAPER_MODE, urls };
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    // Index outputs by the URL we sent (echoed as originalQuery.url), by URN id
    // and by normalized name. The echoed URL is the only exact key for a
    // Short-mode search lead: its /in/ACwAA… id is not the id this actor returns.
    const byQuery = new Map<string, Rec>();
    const byId = new Map<string, Rec>();
    const byName = new Map<string, Rec>();
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const query = raw.originalQuery;
      const queryId = extractProfileId(typeof query === "string" ? query : str((query as Rec | undefined)?.url));
      if (queryId) byQuery.set(queryId, raw);
      const id =
        str(raw.id) ??
        extractProfileId(str(raw.linkedinUrl) ?? str(raw.url) ?? undefined);
      if (id) byId.set(id, raw);
      const nameKey = `${lc(str(raw.firstName))}|${lc(str(raw.lastName))}`;
      if (nameKey !== "|" && !byName.has(nameKey)) byName.set(nameKey, raw);
    }

    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      const sentId = extractProfileId(it.linkedin_url);
      let rec: Rec | undefined = sentId ? byQuery.get(sentId) : undefined;
      const id = it.profile_id ?? sentId;
      if (!rec && id) rec = byId.get(id);
      if (!rec) {
        const nameKey = `${lc(it.first_name)}|${lc(it.last_name)}`;
        if (nameKey !== "|") rec = byName.get(nameKey);
      }
      if (!rec) {
        out.set(it.id, { status: "not_found" });
        continue;
      }

      const { email, verified, free } = pickEmail(rec);
      const companyLinkedinUrl = pickCompanyLinkedinUrl(rec, it.company_name);
      const current = pickCurrentTitle(rec, it.company_name);
      const title = current?.title ?? null;
      const extra: Record<string, unknown> = {
        profile: {
          headline: str(rec.headline),
          location: rec.location ?? null,
          title,
          title_company: current?.company ?? null,
          title_source: current ? (current.matchedCompany ? "company_match" : "first_current") : null,
          // Read by the other-employer email check once the company domain is known.
          email_free: email ? free : null,
          scraped_at: new Date().toISOString(),
        },
      };

      if (!email) {
        out.set(it.id, {
          status: "not_found",
          companyLinkedinUrl,
          title,
          extra,
          raw: trimRaw(rec),
        });
        continue;
      }

      out.set(it.id, {
        status: "found",
        email,
        confidence: verified ? 90 : 60,
        companyLinkedinUrl,
        title,
        extra,
        raw: trimRaw(rec),
      });
    }
    return out;
  },
};
