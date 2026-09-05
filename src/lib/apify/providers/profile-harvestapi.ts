import { extractProfileId, sanitizeCompanyUrl } from "../domain";
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
function pickEmail(rec: Rec): { email: string | null; verified: boolean } {
  let email =
    str(rec.email) ??
    str(rec.workEmail) ??
    str(rec.professionalEmail) ??
    str(rec.emailAddress) ??
    str((rec.contactInfo as Rec | undefined)?.email);

  if (!email && Array.isArray(rec.emails) && rec.emails.length > 0) {
    const first = rec.emails[0];
    email = typeof first === "string" ? first.trim() : str((first as Rec)?.email);
  }
  if (!email) return { email: null, verified: false };

  const statusRaw =
    str(rec.emailStatus) ??
    str((rec.emailVerification as Rec | undefined)?.status) ??
    str(rec.email_status) ??
    "";
  const verified = /valid|deliverable|verified|safe/i.test(statusRaw);
  return { email, verified };
}

function pickCompanyLinkedinUrl(rec: Rec): string | null {
  const positions =
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
    // Index outputs by URN id and by normalized name.
    const byId = new Map<string, Rec>();
    const byName = new Map<string, Rec>();
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const id =
        str(raw.id) ??
        extractProfileId(str(raw.linkedinUrl) ?? str(raw.url) ?? undefined);
      if (id) byId.set(id, raw);
      const nameKey = `${lc(str(raw.firstName))}|${lc(str(raw.lastName))}`;
      if (nameKey !== "|" && !byName.has(nameKey)) byName.set(nameKey, raw);
    }

    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      const id = it.profile_id ?? extractProfileId(it.linkedin_url);
      let rec: Rec | undefined = id ? byId.get(id) : undefined;
      if (!rec) {
        const nameKey = `${lc(it.first_name)}|${lc(it.last_name)}`;
        if (nameKey !== "|") rec = byName.get(nameKey);
      }
      if (!rec) {
        out.set(it.id, { status: "not_found" });
        continue;
      }

      const { email, verified } = pickEmail(rec);
      const companyLinkedinUrl = pickCompanyLinkedinUrl(rec);
      const extra: Record<string, unknown> = {
        profile: {
          headline: str(rec.headline),
          location: rec.location ?? null,
          scraped_at: new Date().toISOString(),
        },
      };

      if (!email) {
        out.set(it.id, {
          status: "not_found",
          companyLinkedinUrl,
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
        extra,
        raw: trimRaw(rec),
      });
    }
    return out;
  },
};
