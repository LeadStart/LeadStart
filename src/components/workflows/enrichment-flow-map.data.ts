// Enrichment Flow Map — DATA (single source for the diagram content).
//
// SYNC CONTRACT (see docs/PROSPECTING_FLOW.md — the canonical flow doc):
//   • Costs + default behaviour are DERIVED from the live constants below
//     (pricing.ts, types/app.ts). A price change or a flipped default updates
//     the map automatically; a renamed constant breaks the build.
//   • Actor IDs are the string literals in ACTORS. scripts/test-flow-map-sync.ts
//     extracts the current ids from the provider source and FAILS if the map
//     falls out of sync — run it (and update this file) whenever a sourcing
//     actor, enrichment phase/provider, cost, or the default config changes.
//   • Structure (phase order, skip logic, branches) is hand-drawn here and in
//     PROSPECTING_FLOW.md; keep the two in step in the SAME change.

import {
  PROFILE_EMAIL_COST_USD,
  DOMAIN_COST_USD,
  MV_CREDIT_COST_USD,
  MAPS_PLACE_COST_USD,
  DOMAIN_DISCOVERY_COST_USD,
  NAMING_COST_USD,
} from "@/lib/apify/pricing";
import { DEFAULT_ENRICHMENT_SETTINGS as CFG, DEFAULT_ENRICHMENT_ADDONS as ADDONS } from "@/types/app";

// ---- diagram vocabulary (structure only; colours/fonts live in the component)
export type Tone =
  | "srcLi" | "srcMaps" | "step" | "stepV" | "addon" | "skip"
  | "good" | "warn" | "grey" | "dia" | "done";
export type LineStyle = "title" | "titleSm" | "actor" | "muted" | "hit" | "pq" | "mv" | "opt" | "dia" | "done";
export type Line = { t: string; s: LineStyle };
export type NodeKind = "box" | "diamond" | "pill";
export type FlowNode = { id: string; kind: NodeKind; x: number; y: number; w: number; h: number; tone: Tone; lines: Line[] };
export type FlowEdge = { pts: [number, number][]; label?: string; at?: [number, number]; dash?: string };

// ---- Apify / provider actor IDs shown on the map (guarded by the sync test).
export const ACTORS = {
  profileSearch: "harvestapi~linkedin-profile-search",
  profileScraper: "harvestapi~linkedin-profile-scraper",
  company: "harvestapi~linkedin-company",
  activity: "harvestapi~linkedin-profile-posts",
  siteScrape: "site-contact-scraper",
  mapsSource: "compass~google-maps-extractor",
} as const;

// ---- derived display values (auto-synced to the live constants) -------------
const usd = (n: number) => `$${n}`; // 0.01 → "$0.01", 0.004 → "$0.004", 0.0037 → "$0.0037"
const MV_RANGE = `~$${MV_CREDIT_COST_USD.toFixed(3)}-${(MV_CREDIT_COST_USD * 3).toFixed(3)}`; // ~$0.004-0.011
const DEFAULT_METHOD = CFG.small_method; // "pattern_mv" while the default bands agree
const addonTag = (on: boolean) => (on ? "(add-on, on)" : "(add-on, off)");
const CATCHALL_NOTE = CFG.accept_catch_all_guesses ? "kept · conf 40 by default" : "(conf 40 if toggle on)";

// Declared estimates with no single exported constant (measured / per-unit
// figures). Low-drift; provenance noted so the sync test / a reader can trace them.
const SEARCH_SHORT_USD = 0.004; // harvestapi profile-search Short = $0.10 / 25 results
const ACTIVITY_PER_POST_USD = 0.002; // harvestapi profile-posts, per post (MAX_POSTS=1 → ~$0.002)
const SITE_SCRAPE_MEASURED_USD = 0.003; // live-pricing measured (compute-billed; estimate const is $0.006)

// ---------------------------------------------------------------- LinkedIn vein
export const LI_NODES: FlowNode[] = [
  { id: "src", kind: "box", x: 50, y: 20, w: 300, h: 66, tone: "srcLi",
    lines: [{ t: "Source · ICP search", s: "title" }, { t: ACTORS.profileSearch, s: "actor" }, { t: `${usd(SEARCH_SHORT_USD)} / profile · ON HIT`, s: "hit" }] },
  { id: "prof", kind: "box", x: 50, y: 128, w: 300, h: 66, tone: "step",
    lines: [{ t: "Phase 1 · Profiles  (primary email)", s: "title" }, { t: ACTORS.profileScraper, s: "actor" }, { t: `${usd(PROFILE_EMAIL_COST_USD)} / profile · PER QUERY`, s: "pq" }] },
  { id: "d1", kind: "diamond", x: 120, y: 236, w: 160, h: 72, tone: "dia",
    lines: [{ t: "Email on the", s: "dia" }, { t: "profile?", s: "dia" }] },
  { id: "yes1", kind: "box", x: 380, y: 248, w: 240, h: 48, tone: "good",
    lines: [{ t: "contacts.email set", s: "titleSm" }, { t: "skips the waterfall → Verify", s: "muted" }] },
  { id: "dom", kind: "box", x: 50, y: 342, w: 300, h: 66, tone: "step",
    lines: [{ t: "Phase 2 · Domains", s: "title" }, { t: ACTORS.company, s: "actor" }, { t: `${usd(DOMAIN_COST_USD)} / company · PER QUERY`, s: "pq" }] },
  { id: "wf", kind: "box", x: 50, y: 450, w: 300, h: 70, tone: "stepV",
    lines: [{ t: "Phase 3 · Waterfall (fallback)", s: "title" }, { t: `${DEFAULT_METHOD} · first.last@domain + MV`, s: "actor" }, { t: `MV ${MV_RANGE} · ON HIT`, s: "mv" }] },
  { id: "d2", kind: "diamond", x: 120, y: 560, w: 160, h: 72, tone: "dia",
    lines: [{ t: "MV verdict?", s: "dia" }] },
  { id: "ca", kind: "box", x: 380, y: 552, w: 240, h: 44, tone: "warn",
    lines: [{ t: "catch-all → drop", s: "titleSm" }, { t: CATCHALL_NOTE, s: "muted" }] },
  { id: "none", kind: "box", x: 380, y: 606, w: 240, h: 44, tone: "grey",
    lines: [{ t: "none → no email", s: "titleSm" }, { t: "keep the LinkedIn URL", s: "muted" }] },
  { id: "ok", kind: "box", x: 50, y: 674, w: 300, h: 46, tone: "good",
    lines: [{ t: "ok → contacts.email · conf 85", s: "titleSm" }] },
  { id: "act", kind: "box", x: 50, y: 762, w: 300, h: 66, tone: "addon",
    lines: [{ t: `Phase 4 · Activity  ${addonTag(ADDONS.activity)}`, s: "title" }, { t: ACTORS.activity, s: "actor" }, { t: `~${usd(ACTIVITY_PER_POST_USD)} · 1 post sampled`, s: "opt" }] },
  { id: "ver", kind: "box", x: 50, y: 870, w: 300, h: 66, tone: "addon",
    lines: [{ t: `Phase 5 · Verify  ${addonTag(ADDONS.verify)}`, s: "title" }, { t: "Million Verifier · or send-gate", s: "actor" }, { t: `~${usd(MV_CREDIT_COST_USD)} / decisive · ON HIT`, s: "opt" }] },
  { id: "ready", kind: "pill", x: 120, y: 978, w: 160, h: 44, tone: "done",
    lines: [{ t: "Contact ready", s: "done" }] },
];
export const LI_EDGES: FlowEdge[] = [
  { pts: [[200, 86], [200, 128]] },
  { pts: [[200, 194], [200, 236]] },
  { pts: [[200, 308], [200, 342]], label: "no", at: [200, 325] },
  { pts: [[280, 272], [380, 272]], label: "yes", at: [330, 260] },
  { pts: [[200, 408], [200, 450]], label: "still no email", at: [200, 429] },
  { pts: [[200, 520], [200, 560]] },
  { pts: [[280, 596], [380, 574]], label: "catch-all", at: [335, 556] },
  { pts: [[280, 596], [380, 628]], label: "none", at: [332, 640] },
  { pts: [[200, 632], [200, 674]], label: "ok", at: [200, 653] },
  { pts: [[200, 720], [200, 762]] },
  { pts: [[200, 828], [200, 870]] },
  { pts: [[200, 936], [200, 978]] },
];

// ---------------------------------------------------------------- Maps vein
export const MAPS_NODES: FlowNode[] = [
  { id: "src", kind: "box", x: 140, y: 20, w: 300, h: 80, tone: "srcMaps",
    lines: [{ t: "Source · geo + business type", s: "title" }, { t: ACTORS.mapsSource, s: "actor" }, { t: `~${usd(MAPS_PLACE_COST_USD)} / place · ON HIT`, s: "hit" }, { t: "gets phone + domain · no email/person", s: "muted" }] },
  { id: "prof", kind: "box", x: 140, y: 140, w: 300, h: 56, tone: "skip",
    lines: [{ t: "Phase 1 · Profiles", s: "title" }, { t: "SKIPPED — no LinkedIn URL", s: "muted" }] },
  { id: "dom", kind: "box", x: 140, y: 236, w: 300, h: 66, tone: "step",
    lines: [{ t: "Phase 2 · Domains", s: "title" }, { t: "web-lookup if missing", s: "actor" }, { t: `~${usd(DOMAIN_DISCOVERY_COST_USD)} · often no-op`, s: "muted" }] },
  { id: "nam", kind: "box", x: 140, y: 344, w: 300, h: 78, tone: "addon",
    lines: [{ t: `Phase 3 · Naming  ${ADDONS.naming ? "(add-on, on)" : "(add-on)"}`, s: "title" }, { t: "decision-maker · Perplexity Sonar", s: "actor" }, { t: `~${usd(NAMING_COST_USD)} / business`, s: "opt" }] },
  { id: "d", kind: "diamond", x: 210, y: 460, w: 160, h: 72, tone: "dia",
    lines: [{ t: "Owner named?", s: "dia" }] },
  { id: "pm", kind: "box", x: 30, y: 578, w: 220, h: 80, tone: "stepV",
    lines: [{ t: `Waterfall · ${DEFAULT_METHOD}`, s: "titleSm" }, { t: "guess owner email + MV", s: "actor" }, { t: "ok → email conf 85", s: "muted" }, { t: "miss → site_scrape", s: "muted" }] },
  { id: "ss", kind: "box", x: 330, y: 578, w: 220, h: 80, tone: "step",
    lines: [{ t: "Waterfall · site_scrape", s: "titleSm" }, { t: ACTORS.siteScrape, s: "actor" }, { t: `~${usd(SITE_SCRAPE_MEASURED_USD)}/site · PER QUERY`, s: "pq" }, { t: "info@ → contacts.email conf 30", s: "muted" }] },
  { id: "act", kind: "box", x: 140, y: 700, w: 300, h: 56, tone: "skip",
    lines: [{ t: "Phase 4 · Activity", s: "title" }, { t: "SKIPPED — no LinkedIn URL", s: "muted" }] },
  { id: "ver", kind: "box", x: 140, y: 796, w: 300, h: 66, tone: "addon",
    lines: [{ t: `Phase 5 · Verify  ${addonTag(ADDONS.verify)}`, s: "title" }, { t: "Million Verifier · or send-gate", s: "actor" }, { t: `~${usd(MV_CREDIT_COST_USD)} / decisive · ON HIT`, s: "opt" }] },
  { id: "ready", kind: "pill", x: 210, y: 904, w: 160, h: 44, tone: "done",
    lines: [{ t: "Contact ready", s: "done" }] },
];
export const MAPS_EDGES: FlowEdge[] = [
  { pts: [[290, 100], [290, 140]] },
  { pts: [[290, 196], [290, 236]] },
  { pts: [[290, 302], [290, 344]] },
  { pts: [[290, 422], [290, 460]] },
  { pts: [[290, 532], [140, 560], [140, 578]], label: "yes", at: [196, 552] },
  { pts: [[290, 532], [440, 560], [440, 578]], label: "no", at: [384, 552] },
  { pts: [[140, 658], [140, 682], [290, 682], [290, 700]] },
  { pts: [[440, 658], [440, 682], [290, 682]] },
  { pts: [[290, 756], [290, 796]] },
  { pts: [[290, 862], [290, 904]] },
];
