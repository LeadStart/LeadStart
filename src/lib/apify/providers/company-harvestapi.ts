import { extractCompanyId, extractCompanySlug, normalizeCompanyName, normalizeDomain } from "../domain";
import { trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

export const DOMAIN_ACTOR_ID = "harvestapi~linkedin-company";

// If numeric-id company URLs (/company/19178324) turn out not to resolve, flip
// this to also search by company name. Off by default: a name search can match
// the wrong company, and we only want the right company's domain. Pin the
// numeric-id question on the first live run.
const USE_NAME_SEARCH_FALLBACK = false;

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export const companyProvider: PhaseProvider = {
  id: "harvestapi-company",
  actorId: DOMAIN_ACTOR_ID,

  buildInput(items: ProviderItem[]): unknown {
    const companies = Array.from(
      new Set(items.map((it) => it.company_linkedin_url).filter((u): u is string => Boolean(u))),
    );
    const input: Record<string, unknown> = { companies };
    if (USE_NAME_SEARCH_FALLBACK) {
      const searches = Array.from(
        new Set(items.map((it) => it.company_name).filter((n): n is string => Boolean(n))),
      );
      if (searches.length) input.searches = searches;
    }
    return input;
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    const byId = new Map<string, Rec>();
    const bySlug = new Map<string, Rec>();
    const byName = new Map<string, Rec>();
    const nameCount = new Map<string, number>();

    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const id = str(raw.id) ?? extractCompanyId(str(raw.linkedinUrl) ?? undefined);
      if (id) byId.set(String(id), raw);
      const slug =
        extractCompanySlug(str(raw.linkedinUrl) ?? undefined) ??
        (str(raw.universalName)?.toLowerCase() ?? null);
      if (slug) bySlug.set(slug, raw);
      const nk = normalizeCompanyName(str(raw.name));
      if (nk) {
        nameCount.set(nk, (nameCount.get(nk) ?? 0) + 1);
        if (!byName.has(nk)) byName.set(nk, raw);
      }
    }

    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      let rec: Rec | undefined;
      let matchedBy = "";
      if (it.company_id && byId.has(it.company_id)) {
        rec = byId.get(it.company_id);
        matchedBy = "id";
      }
      if (!rec && it.company_slug && bySlug.has(it.company_slug)) {
        rec = bySlug.get(it.company_slug);
        matchedBy = "slug";
      }
      if (!rec && it.company_name) {
        const nk = normalizeCompanyName(it.company_name);
        if (nk && nameCount.get(nk) === 1) {
          rec = byName.get(nk);
          matchedBy = "name";
        }
      }

      if (!rec) {
        out.set(it.id, { status: "not_found", extra: { domain_note: "no company data returned" } });
        continue;
      }

      const website = str(rec.website);
      const domain = normalizeDomain(website);
      if (!domain) {
        out.set(it.id, {
          status: "not_found",
          extra: {
            company: { name: str(rec.name), linkedinUrl: str(rec.linkedinUrl), website },
            domain_note: `company found (by ${matchedBy}), no usable website: ${website ?? "∅"}`,
          },
          raw: trimRaw(rec),
        });
        continue;
      }

      out.set(it.id, {
        status: "found",
        companyDomain: domain,
        extra: {
          matched_by: matchedBy,
          company: {
            id: str(rec.id) ?? it.company_id,
            name: str(rec.name),
            linkedinUrl: str(rec.linkedinUrl),
            website,
            employeeCount: rec.employeeCount ?? null,
            industries: rec.industries ?? null,
            resolved_at: new Date().toISOString(),
          },
        },
        raw: trimRaw(rec),
      });
    }
    return out;
  },
};
