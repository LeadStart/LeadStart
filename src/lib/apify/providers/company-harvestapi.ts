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

// Company phone from the harvestapi record. Shape is usually
// `phone: { number, extension }`; tolerate a bare string too.
function companyPhone(rec: Rec): string | null {
  const p = rec.phone;
  if (p && typeof p === "object") {
    const num = str((p as Rec).number);
    if (!num) return null;
    const ext = str((p as Rec).extension);
    return ext ? `${num} x${ext}` : num;
  }
  return str(p);
}

// Employee count is the size-routing input (migration 00075). Coerce number|string.
function companyEmployeeCount(rec: Rec): number | null {
  const n = rec.employeeCount;
  if (typeof n === "number" && Number.isFinite(n)) return Math.round(n);
  if (typeof n === "string" && n.trim() && Number.isFinite(Number(n))) return Math.round(Number(n));
  return null;
}

// Compact HQ location line (provenance only): field names vary, so probe a few.
function companyHq(rec: Rec): string | null {
  const fromLoc = (loc: unknown): string | null => {
    if (typeof loc === "string") return str(loc);
    if (!loc || typeof loc !== "object") return null;
    const l = loc as Rec;
    const explicit = str(l.address) ?? str(l.description) ?? str(l.formatted);
    if (explicit) return explicit;
    const parts = [
      str(l.city),
      str(l.geographicArea) ?? str(l.state) ?? str(l.region),
      str(l.country),
    ].filter((s): s is string => Boolean(s));
    return parts.length ? parts.join(", ") : null;
  };
  const direct = rec.headquarter ?? rec.headquarters ?? rec.hq;
  if (direct) {
    const s = fromLoc(direct);
    if (s) return s;
  }
  const locs = rec.locations;
  if (Array.isArray(locs) && locs.length) {
    const flagged = (locs as Rec[]).find(
      (l) => l && typeof l === "object" && (l.isHeadquarter || l.headquarter || l.isPrimary),
    );
    const s = fromLoc(flagged ?? locs[0]);
    if (s) return s;
  }
  return null;
}

// Denormalized company block persisted into enrichment_data.enrichment.company.
// The domain-phase ingest also lifts `phone` → contacts.phone (fill-only) and
// `employeeCount` → enrichment_run_items.employee_count for size routing.
function companyBlock(rec: Rec, fallbackId: string | null): Record<string, unknown> {
  return {
    id: str(rec.id) ?? fallbackId,
    name: str(rec.name),
    linkedinUrl: str(rec.linkedinUrl),
    website: str(rec.website),
    employeeCount: companyEmployeeCount(rec),
    phone: companyPhone(rec),
    hq: companyHq(rec),
    industries: rec.industries ?? null,
    resolved_at: new Date().toISOString(),
  };
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
          // Company record resolved but no website → no domain. We still keep
          // the company block so the ingest can lift phone + employeeCount.
          extra: {
            company: companyBlock(rec, it.company_id),
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
          company: companyBlock(rec, it.company_id),
        },
        raw: trimRaw(rec),
      });
    }
    return out;
  },
};
