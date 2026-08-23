import { normalizeDomain } from "../domain";
import { lc, trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

// Top-tier community contact scraper (4.72★), used for the second-pass email
// waterfall on profile misses. We crawl the company domain shallowly and read
// the leadsEnrichment records, matching our specific person by name. (Not an
// Apify-official actor — an earlier "Maintained by Apify" note was an error.)
export const WATERFALL_VDRMOTA_ACTOR_ID = "vdrmota~contact-info-scraper";

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The actor's own verification string for a lead, if any — kept as provenance,
// never mapped into a competing verdict. Million Verifier owns the send-gate.
function rawVerification(rec: Rec): string | null {
  return (
    str(rec.emailVerificationStatus) ??
    str((rec.emailVerification as Rec | undefined)?.status) ??
    str(rec.verificationStatus) ??
    str(rec.emailStatus) ??
    null
  );
}

export const waterfallVdrmotaProvider: PhaseProvider = {
  id: "vdrmota",
  actorId: WATERFALL_VDRMOTA_ACTOR_ID,

  buildInput(items: ProviderItem[]): unknown {
    const domains = Array.from(
      new Set(items.map((it) => it.company_domain).filter((d): d is string => Boolean(d))),
    );
    return {
      startUrls: domains.map((d) => ({ url: `https://${d}` })),
      maxDepth: 1,
      maxRequestsPerStartUrl: 10,
      sameDomain: true,
      maximumLeadsEnrichmentRecords: 10,
      verifyLeadsEnrichmentEmails: true,
    };
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    // Index output records by normalized domain (a record is per start URL).
    const byDomain = new Map<string, Rec>();
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const d = normalizeDomain(str(raw.domain)) ?? normalizeDomain(str(raw.url));
      if (d && !byDomain.has(d)) byDomain.set(d, raw);
    }

    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      const domain = it.company_domain ? normalizeDomain(it.company_domain) : null;
      const rec = domain ? byDomain.get(domain) : undefined;
      if (!rec) {
        out.set(it.id, { status: "not_found", extra: { waterfall_note: "domain not crawled" } });
        continue;
      }

      const companyEmails = Array.isArray(rec.emails)
        ? (rec.emails as unknown[]).filter((e): e is string => typeof e === "string")
        : [];
      const extra: Record<string, unknown> = companyEmails.length
        ? { company_emails: companyEmails.slice(0, 10) }
        : {};

      const leads = Array.isArray(rec.leadsEnrichment) ? (rec.leadsEnrichment as Rec[]) : [];
      const wantFirst = lc(it.first_name);
      const wantLast = lc(it.last_name);
      const match = leads.find(
        (l) => lc(str(l.firstName)) === wantFirst && lc(str(l.lastName)) === wantLast,
      );

      if (!match) {
        out.set(it.id, { status: "not_found", extra });
        continue;
      }
      const email = str(match.email);
      if (!email) {
        out.set(it.id, { status: "not_found", extra });
        continue;
      }
      out.set(it.id, {
        status: "found",
        email,
        confidence: 70,
        extra: { ...extra, waterfall_status: rawVerification(match) },
        raw: trimRaw(match),
      });
    }
    return out;
  },
};
