import { DEFAULT_ENRICHMENT_SETTINGS, type EnrichmentSettings } from "@/types/app";
import { normalizeDomain } from "../domain";
import { trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

// Our own site-contact scraper (Phase 3). Runs the private Apify actor built in
// apify-actors/site-contact-scraper — a 5-tier anti-bot fetch waterfall that
// crawls the company site + discovered contact pages and extracts emails,
// phones, socials, and name-matched personal emails. Company-level compute
// pricing (no per-lead events), unlike vdrmota.
//
// The actor id must match the pushed actor. Deployed 2026-08-25 under the owner's
// Apify account (username `indispensable_nonagon`). Still env-overridable via
// SITE_SCRAPE_ACTOR_ID as an escape hatch if the actor later moves accounts.
export const WATERFALL_SCRAPE_ACTOR_ID =
  process.env.SITE_SCRAPE_ACTOR_ID?.trim() || "indispensable_nonagon~site-contact-scraper";

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];
}

// Pick the most trustworthy phone to write to contacts.phone. The actor extracts
// liberally (any phone-shaped text), so choose conservatively here: prefer an
// explicit country code (+…), then a full-length national/intl number (≥10 digits).
// Short bare fragments (<10 digits, no +) are almost always IDs/prices/page noise,
// not diallable numbers — skip rather than write a wrong phone.
function pickBestPhone(phones: string[]): string | null {
  const withPlus = phones.find((p) => p.trim().startsWith("+") && p.replace(/\D/g, "").length >= 8);
  if (withPlus) return withPlus.trim();
  const full = phones.find((p) => p.replace(/\D/g, "").length >= 10);
  return full ? full.trim() : null;
}

function normName(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

interface PersonEmailRec {
  email: string;
  nameMatched: boolean;
}

function personEmailsOf(rec: Rec): PersonEmailRec[] {
  const raw = Array.isArray(rec.personEmails) ? (rec.personEmails as unknown[]) : [];
  const out: PersonEmailRec[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const email = str((p as Rec).email);
    if (email) out.push({ email: email.toLowerCase(), nameMatched: Boolean((p as Rec).nameMatched) });
  }
  return out;
}

// Choose the best personal email for THIS contact. The actor already flagged
// nameMatched against the (representative) target name; for a shared domain we
// re-derive a per-contact local-part match so other contacts still benefit.
function pickPersonEmail(
  emails: PersonEmailRec[],
  first: string | null,
  last: string | null,
): { email: string; confidence: number } | null {
  const actorMatch = emails.find((e) => e.nameMatched);
  if (actorMatch) return { email: actorMatch.email, confidence: 80 };
  const f = normName(first);
  const l = normName(last);
  if (f.length < 2 && l.length < 2) return null;
  for (const e of emails) {
    const nl = normName(e.email.split("@")[0]);
    const hit = (l.length >= 3 && nl.includes(l)) || (f.length >= 3 && nl.includes(f) && (!l || nl.includes(l)));
    if (hit) return { email: e.email, confidence: 60 };
  }
  return null;
}

export const waterfallScrapeProvider: PhaseProvider = {
  id: "site_scrape",
  actorId: WATERFALL_SCRAPE_ACTOR_ID,

  buildInput(items: ProviderItem[], config?: EnrichmentSettings | null): unknown {
    // One target per unique domain (dedup), carrying a representative name for
    // proximity matching. Per-contact matching still happens in parseItems.
    const byDomain = new Map<string, ProviderItem>();
    for (const it of items) {
      const d = it.company_domain ? normalizeDomain(it.company_domain) : null;
      if (d && !byDomain.has(d)) byDomain.set(d, it);
    }
    const targets = Array.from(byDomain, ([domain, it]) => ({
      domain,
      firstName: it.first_name,
      lastName: it.last_name,
    }));
    const maxPages = config?.scrape_max_pages ?? DEFAULT_ENRICHMENT_SETTINGS.scrape_max_pages;
    return {
      targets,
      maxPagesPerDomain: Math.max(1, Math.min(12, Math.round(maxPages))),
      useProxy: false,
      unblockerKey: process.env.SITE_SCRAPE_UNBLOCKER_KEY?.trim() || undefined,
    };
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    const byDomain = new Map<string, Rec>();
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const d = normalizeDomain(str(raw.domain));
      if (d && !byDomain.has(d)) byDomain.set(d, raw);
    }

    const out = new Map<string, PhaseResult>();
    for (const it of items) {
      const domain = it.company_domain ? normalizeDomain(it.company_domain) : null;
      const rec = domain ? byDomain.get(domain) : undefined;
      if (!rec) {
        out.set(it.id, { status: "not_found", extra: { waterfall_note: "domain not scraped" } });
        continue;
      }

      // Company-level extras written regardless of a personal-email hit: phone
      // (fill-only onto the contact) + generic company emails (enrichment_data).
      const companyEmails = strArray(rec.companyEmails).slice(0, 10);
      const phones = strArray(rec.phones);
      const bestPhone = pickBestPhone(phones);
      const extra: Record<string, unknown> = { scrape_outcome: str(rec.fetchOutcome) };
      if (companyEmails.length) extra.company_emails = companyEmails;
      if (bestPhone) extra.phone = bestPhone;

      const match = pickPersonEmail(personEmailsOf(rec), it.first_name, it.last_name);
      if (match) {
        out.set(it.id, {
          status: "found",
          email: match.email,
          confidence: match.confidence,
          extra: { ...extra, waterfall_status: "scraped" },
          raw: trimRaw(rec),
        });
      } else {
        out.set(it.id, {
          status: "not_found",
          extra: { ...extra, waterfall_note: `scraped (${str(rec.fetchOutcome) ?? "?"}), no name-matched email` },
        });
      }
    }
    return out;
  },
};
