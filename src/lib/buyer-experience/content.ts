// The BUYER PORTAL's editable content model + code defaults. One source of truth
// for the copy/presentation the admin "Buyer experience" editor controls and the
// real buyer pages render, so the admin preview and what buyers see never drift.
//
// Pure + isomorphic (no DB, no server-only): the routes merge stored content over
// these defaults; the admin editor + preview and the buyer pages all render the
// same shape.

export type AnnouncementVariant = "info" | "warning" | "success";

export interface BuyerExperience {
  announcement: { enabled: boolean; text: string; variant: AnnouncementVariant };
  dashboard: {
    welcome_body: string;
    balance_note: string;
    packs_heading: string;
    packs_note: string;
    activity_heading: string;
    search_cta_title: string;
    search_cta_body: string;
  };
  empty: { contacts: string; searches: string };
  tips: { search: string };
}

export const DEFAULT_BUYER_EXPERIENCE: BuyerExperience = {
  announcement: { enabled: false, text: "", variant: "info" },
  dashboard: {
    welcome_body:
      "Your self-serve contact-sourcing workspace. Buy tokens, run Maps and LinkedIn searches, and you are only charged for the contacts we actually deliver.",
    balance_note:
      "Tokens are spent only on delivered contacts, never on failed lookups. Held tokens are reserved against a running search and released if unused.",
    packs_heading: "Buy tokens",
    packs_note: "One-time token packs. Top up any time.",
    activity_heading: "Recent activity",
    search_cta_title: "Run a search",
    search_cta_body: "Source businesses on Google Maps and LinkedIn, enriched and verified.",
  },
  empty: {
    contacts: "No contacts yet. Run a search to start sourcing.",
    searches: "No searches yet.",
  },
  tips: {
    search: "",
  },
};

const VARIANTS: AnnouncementVariant[] = ["info", "warning", "success"];

function str(v: unknown, fb: string): string {
  return typeof v === "string" ? v : fb;
}
function bool(v: unknown, fb: boolean): boolean {
  return typeof v === "boolean" ? v : fb;
}

/**
 * Coerce an arbitrary stored/posted blob into a complete, valid BuyerExperience by
 * merging over the defaults. Unknown/malformed fields fall back rather than throw,
 * so a partial edit or an older/newer shape is always safe to render.
 */
export function mergeBuyerExperience(input: unknown): BuyerExperience {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const a = (o.announcement && typeof o.announcement === "object" ? o.announcement : {}) as Record<string, unknown>;
  const d = (o.dashboard && typeof o.dashboard === "object" ? o.dashboard : {}) as Record<string, unknown>;
  const e = (o.empty && typeof o.empty === "object" ? o.empty : {}) as Record<string, unknown>;
  const t = (o.tips && typeof o.tips === "object" ? o.tips : {}) as Record<string, unknown>;
  const D = DEFAULT_BUYER_EXPERIENCE;
  const variant = VARIANTS.includes(a.variant as AnnouncementVariant) ? (a.variant as AnnouncementVariant) : D.announcement.variant;
  return {
    announcement: {
      enabled: bool(a.enabled, D.announcement.enabled),
      text: str(a.text, D.announcement.text),
      variant,
    },
    dashboard: {
      welcome_body: str(d.welcome_body, D.dashboard.welcome_body),
      balance_note: str(d.balance_note, D.dashboard.balance_note),
      packs_heading: str(d.packs_heading, D.dashboard.packs_heading),
      packs_note: str(d.packs_note, D.dashboard.packs_note),
      activity_heading: str(d.activity_heading, D.dashboard.activity_heading),
      search_cta_title: str(d.search_cta_title, D.dashboard.search_cta_title),
      search_cta_body: str(d.search_cta_body, D.dashboard.search_cta_body),
    },
    empty: {
      contacts: str(e.contacts, D.empty.contacts),
      searches: str(e.searches, D.empty.searches),
    },
    tips: {
      search: str(t.search, D.tips.search),
    },
  };
}
