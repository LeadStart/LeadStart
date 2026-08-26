// Lookalike sending-domain name generator (Phase 2).
//
// Cold email never sends from the primary brand domain (a spam complaint there
// hurts the real business). Instead we register human-plausible lookalikes and
// treat them as consumable sending infrastructure. This produces candidate bare
// domains from a brand; the caller availability-checks them via the registrar
// before buying. Pure — no I/O.

/** Default patterns: conservative, pronounceable, common in cold-email setups. */
export const DEFAULT_NAME_PATTERNS: ((brand: string) => string)[] = [
  (b) => `try${b}`,
  (b) => `get${b}`,
  (b) => `${b}hq`,
  (b) => `${b}team`,
  (b) => `${b}mail`,
  (b) => `hey${b}`,
  (b) => `the${b}`,
  (b) => `${b}app`,
  (b) => `${b}hub`,
  (b) => `${b}group`,
];

export function generateLookalikeDomains(params: {
  /** Brand label; a full domain like "leadstart.com" is reduced to "leadstart". */
  brand: string;
  /** TLDs to pair each pattern with. Default ["com"]. */
  tlds?: string[];
  patterns?: ((brand: string) => string)[];
  /** Domains to never emit — always include the real primary domain(s). */
  excludePrimary?: string[];
  /** Cap the number of candidates returned. */
  limit?: number;
}): string[] {
  const brand = normalizeLabel((params.brand ?? "").split(".")[0]);
  if (!brand) return [];
  const tlds = params.tlds?.length ? params.tlds : ["com"];
  const patterns = params.patterns?.length ? params.patterns : DEFAULT_NAME_PATTERNS;
  const exclude = new Set((params.excludePrimary ?? []).map((d) => d.trim().toLowerCase()));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawTld of tlds) {
    const tld = rawTld.replace(/^\./, "").trim().toLowerCase();
    if (!tld) continue;
    for (const p of patterns) {
      const label = normalizeLabel(p(brand));
      if (!label) continue;
      const domain = `${label}.${tld}`;
      if (exclude.has(domain) || seen.has(domain)) continue;
      seen.add(domain);
      out.push(domain);
      if (params.limit && out.length >= params.limit) return out;
    }
  }
  return out;
}

/** Lowercase, keep only [a-z0-9-], trim leading/trailing hyphens. */
function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "");
}
