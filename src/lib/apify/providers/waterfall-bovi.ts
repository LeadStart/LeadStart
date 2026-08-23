import { personKey, trimRaw, type PhaseProvider, type PhaseResult, type ProviderItem } from "./types";

// Free-tier alternative to vdrmota for the waterfall (pay only per found email).
// Registered but not the default — see providers/index.ts. Batch name+domain.
export const WATERFALL_BOVI_ACTOR_ID = "bovi~email-finder-bulk";

type Rec = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export const waterfallBoviProvider: PhaseProvider = {
  id: "bovi",
  actorId: WATERFALL_BOVI_ACTOR_ID,

  buildInput(items: ProviderItem[]): unknown {
    const people = items
      .filter((it) => it.first_name && it.last_name && it.company_domain)
      .map((it) => ({
        firstName: it.first_name,
        lastName: it.last_name,
        domain: it.company_domain,
      }));
    return { people, verifySmtp: true, maxAlternatives: 0 };
  },

  parseItems(datasetItems: unknown[], items: ProviderItem[]): Map<string, PhaseResult> {
    // Index by echoed person key; fall back to positional if lengths match.
    const byKey = new Map<string, Rec>();
    let echoed = 0;
    for (const raw of datasetItems as Rec[]) {
      if (!raw || typeof raw !== "object") continue;
      const first = str(raw.firstName) ?? str(raw.first_name);
      const last = str(raw.lastName) ?? str(raw.last_name) ?? str(raw.surname);
      const domain = str(raw.domain) ?? str(raw.companyDomain);
      if (first || last || domain) {
        byKey.set(personKey(first, last, domain), raw);
        echoed++;
      }
    }
    const positional =
      echoed === 0 && datasetItems.length === items.length ? (datasetItems as Rec[]) : null;

    const out = new Map<string, PhaseResult>();
    items.forEach((it, i) => {
      let rec = byKey.get(personKey(it.first_name, it.last_name, it.company_domain));
      if (!rec && positional) rec = positional[i];
      if (!rec) {
        out.set(it.id, { status: "not_found" });
        return;
      }
      const email = str(rec.email);
      if (!email) {
        out.set(it.id, { status: "not_found", raw: trimRaw(rec) });
        return;
      }
      const conf = typeof rec.confidence === "number" ? Math.round(rec.confidence * 100) : 60;
      out.set(it.id, {
        status: "found",
        email,
        confidence: conf,
        // Provider's own status kept as provenance (feeds catch-all adjudication);
        // Million Verifier is the send-gate authority, not this string.
        extra: { waterfall_status: str(rec.status) ?? null },
        raw: trimRaw(rec),
      });
    });
    return out;
  },
};
