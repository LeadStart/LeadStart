"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Search,
  Loader2,
  MapPin,
  Building2,
  X,
  History,
  Bookmark,
  Star,
  Globe,
  Phone,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Rocket,
  Hash,
  Map as MapIcon,
  Landmark,
  Sparkles,
  Stethoscope,
  Activity,
  Wind,
  HardHat,
  Droplets,
  SprayCan,
  Scale,
  Dumbbell,
  Car,
  Trees,
  Home,
  type LucideIcon,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { createClient } from "@/lib/supabase/client";
import { classifyEmailTier, EMAIL_TIER_RANK, type EmailTier } from "@/lib/enrichment/email-tier";
import type { MapsPlace, MapsSearchStatus } from "@/types/app";
import type { MapsArea } from "@/lib/apify/sourcing/maps-search";

// The DIY Google-Maps lead-search flow — a "D + running cart" build experience.
// LEFT: where your customers are (a Smart Search location picker → multi-region),
// then ready-to-run audiences. RIGHT: a sticky "Your search" cart (areas /
// audiences / enrichment / how many leads / outcome estimate / run). Sources
// businesses via the compass actor (one run per area, merged), streams results,
// and imports selected leads into Contacts. Restructured for a self-serve DIY
// flow; uses the Maps vein's existing polling/import/preset/pricing endpoints.

const POLL_MS = 3000;
const RESULTS_PAGE_SIZE = 25;
const GEO_DEBOUNCE_MS = 180;

// Ready-to-run audiences — each adds a bundle of Google Maps search terms.
const AUDIENCES: { label: string; terms: string[]; blurb: string; icon: LucideIcon }[] = [
  { label: "Med spas", terms: ["med spa", "medical spa"], blurb: "Aesthetic & wellness clinics", icon: Sparkles },
  { label: "Dentists", terms: ["dentist", "dental clinic"], blurb: "General & cosmetic dental", icon: Stethoscope },
  { label: "Chiropractors", terms: ["chiropractor"], blurb: "Chiro & wellness", icon: Activity },
  { label: "HVAC", terms: ["hvac contractor", "air conditioning repair"], blurb: "Heating & cooling", icon: Wind },
  { label: "Roofers", terms: ["roofing contractor"], blurb: "Residential & commercial roofing", icon: HardHat },
  { label: "Plumbers", terms: ["plumber"], blurb: "Plumbing services", icon: Droplets },
  { label: "Commercial cleaning", terms: ["commercial cleaning service", "janitorial service"], blurb: "Janitorial & office cleaning", icon: SprayCan },
  { label: "Law firms", terms: ["law firm", "attorney"], blurb: "Attorneys & legal practices", icon: Scale },
  { label: "Gyms & studios", terms: ["gym", "fitness studio"], blurb: "Fitness & training", icon: Dumbbell },
  { label: "Auto repair", terms: ["auto repair shop"], blurb: "Mechanics & body shops", icon: Car },
  { label: "Landscaping", terms: ["landscaping service"], blurb: "Lawn & landscape", icon: Trees },
  { label: "Real estate", terms: ["real estate agency"], blurb: "Agencies & brokerages", icon: Home },
];

// A couple of one-tap big-state adds beneath the picker.
const QUICK_STATES: { name: string; label: string }[] = [
  { name: "California", label: "California" },
  { name: "Texas", label: "Texas" },
  { name: "Florida", label: "Florida" },
  { name: "New York", label: "New York" },
];

const MAX_OPTIONS = [100, 250, 500, 1000];
const STAR_OPTIONS = [
  { v: "", label: "Any rating" },
  { v: "3.5", label: "3.5★ +" },
  { v: "4.0", label: "4.0★ +" },
  { v: "4.5", label: "4.5★ +" },
];

type GeoKind = "country" | "state" | "county" | "city";
type GeoResult = {
  id: number;
  kind: GeoKind;
  name: string;
  state_code: string | null;
  state_name: string | null;
  label: string;
};

type MapsSearchDetail = {
  id: string;
  query: { levers?: Record<string, unknown>; addons?: Record<string, unknown>; name?: string } | null;
  results: MapsPlace[];
  result_count: number;
  target_max_results: number;
  truncated: boolean;
  saved_count: number;
  status: MapsSearchStatus;
  progress_message: string | null;
  error_message: string | null;
  cost_usd: number | string;
  delivered_counts?: Record<string, number>;
  created_at: string;
};

type PriorRun = {
  id: string;
  query: { name?: string; levers?: { searchTerms?: string[]; locationQuery?: string; areas?: MapsArea[] } } | null;
  result_count: number;
  saved_count: number;
  status: MapsSearchStatus;
  cost_usd: number | string;
  created_at: string;
};

type Preset = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  config: MapsConfig;
  is_global: boolean;
};

type MapsConfig = {
  searchTerms?: string[];
  websiteFilter?: "all" | "with" | "without";
  minStars?: string;
  addNaming?: boolean;
  addVerify?: boolean;
  addCatchAll?: boolean;
  maxResults?: number;
};

type Campaign = { id: string; name: string };

type LivePricing = {
  maps?: { place?: number };
  enrich?: { site_scrape?: number; naming?: number; domain_discovery?: number };
};

function num(v: number | string | null | undefined): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Stable identity for an area chip (dedupe + remove).
function areaKey(a: MapsArea): string {
  return [a.level, (a.name ?? "").toLowerCase(), (a.state ?? "").toLowerCase(), a.postalCode ?? ""].join("|");
}

function areaLabel(a: MapsArea): string {
  if (a.label) return a.label;
  if (a.level === "zip") return `ZIP ${a.postalCode ?? ""}`;
  if (a.level === "state") return a.state ?? "";
  const st = a.state ? `, ${a.state}` : "";
  return `${a.name ?? ""}${st}`;
}

// geo-typeahead row → a structured MapsArea (country is not a Maps level).
function geoResultToArea(r: GeoResult): MapsArea | null {
  const state = r.state_name ?? undefined;
  if (r.kind === "state") return { level: "state", state: r.name, countryCode: "us", label: r.name };
  if (r.kind === "county") return { level: "county", name: r.name, state, countryCode: "us", label: r.label };
  if (r.kind === "city") return { level: "city", name: r.name, state, countryCode: "us", label: r.label };
  return null;
}

const KIND_META: Record<GeoKind, { group: string; icon: typeof MapPin }> = {
  city: { group: "Cities", icon: MapPin },
  county: { group: "Counties", icon: MapIcon },
  state: { group: "States", icon: Landmark },
  country: { group: "Countries", icon: Globe },
};

export function MapsDiyPanel() {
  // Build state.
  const [areas, setAreas] = useState<MapsArea[]>([]);
  const [terms, setTerms] = useState<string[]>([]);
  const [termInput, setTermInput] = useState("");
  const [websiteFilter, setWebsiteFilter] = useState<"all" | "with" | "without">("all");
  const [minStars, setMinStars] = useState("");
  const [maxResults, setMaxResults] = useState(250);
  const [addNaming, setAddNaming] = useState(false);
  const [addVerify, setAddVerify] = useState(false);
  const [addCatchAll, setAddCatchAll] = useState(false);
  const [addValidateCatchAll, setAddValidateCatchAll] = useState(false);
  const [searchName, setSearchName] = useState("");

  // Smart Search picker.
  const [locInput, setLocInput] = useState("");
  const [geoResults, setGeoResults] = useState<GeoResult[]>([]);
  const [geoOpen, setGeoOpen] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const geoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Run + results.
  const [searchId, setSearchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MapsSearchDetail | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cartRef = useRef<HTMLDivElement | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [targetCampaign, setTargetCampaign] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [presets, setPresets] = useState<Preset[]>([]);
  const [priorRuns, setPriorRuns] = useState<PriorRun[]>([]);
  const [pricing, setPricing] = useState<LivePricing | null>(null);
  const [presetSlug, setPresetSlug] = useState<string | null>(null);
  const [inCrm, setInCrm] = useState<Set<string>>(new Set());
  const [crmTier, setCrmTier] = useState<Map<string, EmailTier>>(new Map());

  // ---- loaders ----
  const loadPresets = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/maps-search-presets"), { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPresets((data.presets ?? []) as Preset[]);
    } catch {
      /* ignore */
    }
  }, []);

  const loadPriorRuns = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/maps-searches"), { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPriorRuns((data.searches ?? []) as PriorRun[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadPresets();
    loadPriorRuns();
  }, [loadPresets, loadPriorRuns]);

  useEffect(() => {
    fetch(appUrl("/api/admin/enrichment/pricing"), { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setPricing(d as LivePricing))
      .catch(() => {});
  }, []);

  // Keep the sticky "Your search" cart vertically centered in the viewport while
  // the page scrolls (lg only). The sticky `top` is set to the offset that centers
  // the cart's box. Two escapes: below lg the cart isn't sticky (clear the override),
  // and when the cart is taller than the viewport we drop the pin entirely — a
  // pinned over-tall cart would park its Run button below the fold, unreachable.
  // Re-runs on viewport resize and whenever the cart's height changes (areas/audiences).
  useEffect(() => {
    const el = cartRef.current;
    if (!el) return;
    const recenter = () => {
      if (window.innerWidth < 1024) {
        el.style.top = "";
        el.style.position = "";
        return;
      }
      const vh = window.innerHeight;
      const ch = el.offsetHeight;
      if (ch > vh - 32) {
        // Taller than the viewport — scroll normally so the whole cart is reachable.
        el.style.position = "static";
        el.style.top = "";
      } else {
        el.style.position = ""; // revert to the lg:sticky class
        el.style.top = `${Math.max(16, Math.round((vh - ch) / 2))}px`;
      }
    };
    recenter();
    window.addEventListener("resize", recenter);
    const ro = new ResizeObserver(recenter);
    ro.observe(el);
    return () => {
      window.removeEventListener("resize", recenter);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase.from("campaigns").select("id, name").order("created_at", { ascending: false });
      if (!cancelled && data) setCampaigns(data as Campaign[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Smart Search typeahead ----
  useEffect(() => {
    const q = locInput.trim();
    if (geoTimer.current) clearTimeout(geoTimer.current);
    const isZip = /^\d{5}$/.test(q);
    if (q.length < 2 && !isZip) {
      setGeoResults([]);
      setGeoLoading(false);
      return;
    }
    setGeoLoading(true);
    geoTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(
          appUrl(`/api/admin/prospecting/geo-typeahead?q=${encodeURIComponent(q)}&kinds=city,county,state`),
          { cache: "no-store" },
        );
        const data = await res.json();
        setGeoResults((data.results ?? []) as GeoResult[]);
      } catch {
        setGeoResults([]);
      } finally {
        setGeoLoading(false);
      }
    }, GEO_DEBOUNCE_MS);
    return () => {
      if (geoTimer.current) clearTimeout(geoTimer.current);
    };
  }, [locInput]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setGeoOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const addArea = useCallback((a: MapsArea) => {
    setAreas((prev) => (prev.some((x) => areaKey(x) === areaKey(a)) ? prev : [...prev, a]));
    setLocInput("");
    setGeoResults([]);
    setGeoOpen(false);
  }, []);
  const removeArea = (key: string) => setAreas((prev) => prev.filter((a) => areaKey(a) !== key));

  // Grouped dropdown rows: a ZIP suggestion (numeric) + typeahead matches by kind.
  const zipQ = locInput.trim();
  const zipSuggestion: MapsArea | null = /^\d{5}$/.test(zipQ)
    ? { level: "zip", postalCode: zipQ, countryCode: "us", label: `ZIP ${zipQ}` }
    : null;
  const grouped = useMemo(() => {
    const g: Record<string, GeoResult[]> = {};
    for (const r of geoResults) (g[r.kind] ??= []).push(r);
    return (["city", "county", "state"] as GeoKind[]).filter((k) => g[k]?.length).map((k) => ({ kind: k, rows: g[k] }));
  }, [geoResults]);

  // ---- term / audience chips ----
  const addTerm = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setTerms((prev) => (prev.some((x) => x.toLowerCase() === t.toLowerCase()) ? prev : [...prev, t]));
    setTermInput("");
  };
  const removeTerm = (t: string) => setTerms((prev) => prev.filter((x) => x !== t));
  const addAudience = (audTerms: string[]) =>
    setTerms((prev) => {
      const lower = new Set(prev.map((x) => x.toLowerCase()));
      return [...prev, ...audTerms.filter((t) => !lower.has(t.toLowerCase()))];
    });
  const audienceActive = (audTerms: string[]) => {
    const lower = new Set(terms.map((x) => x.toLowerCase()));
    return audTerms.every((t) => lower.has(t.toLowerCase()));
  };

  // ---- presets ----
  const applyPreset = (p: Preset) => {
    const c = p.config ?? {};
    setTerms(Array.isArray(c.searchTerms) ? c.searchTerms : []);
    setWebsiteFilter(c.websiteFilter ?? "all");
    setMinStars(c.minStars ?? "");
    setAddNaming(Boolean(c.addNaming));
    setAddVerify(Boolean(c.addVerify));
    setAddCatchAll(Boolean(c.addCatchAll));
    if (typeof c.maxResults === "number") setMaxResults(c.maxResults);
    if (!searchName) setSearchName(p.name);
    setPresetSlug(p.slug);
  };

  const saveAsPreset = async () => {
    const name = window.prompt("Save this audience as a preset. Name:", searchName || terms[0] || "");
    if (!name) return;
    const config: MapsConfig = { searchTerms: terms, websiteFilter, minStars, addNaming, addVerify, addCatchAll, maxResults };
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/maps-search-presets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, config }),
      });
      if (res.ok) loadPresets();
      else setError((await res.json()).error ?? "Failed to save preset");
    } catch {
      setError("Failed to save preset");
    }
  };

  // ---- in-CRM overlap ----
  const refreshInCrm = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setInCrm(new Set());
      setCrmTier(new Map());
      return;
    }
    try {
      const supabase = createClient();
      const found = new Set<string>();
      const tiers = new Map<string, EmailTier>();
      type CrmRow = {
        google_place_id: string | null;
        email: string | null;
        company_email: string | null;
        email_kind: string | null;
        email_provider_status: string | null;
      };
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase
          .from("contacts")
          .select(
            "google_place_id, email, company_email, email_kind:enrichment_data->enrichment->email->>kind, email_provider_status:enrichment_data->enrichment->email->>provider_status",
          )
          .in("google_place_id", ids.slice(i, i + 300));
        for (const r of (data as unknown as CrmRow[] | null) ?? []) {
          if (!r.google_place_id) continue;
          found.add(r.google_place_id);
          const tier = classifyEmailTier(r);
          if (tier !== "none") tiers.set(r.google_place_id, tier);
        }
      }
      setInCrm(found);
      setCrmTier(tiers);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    refreshInCrm((detail?.results ?? []).map((r) => r.google_place_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.status, detail?.result_count, refreshInCrm]);

  // ---- polling ----
  const stopPoll = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(appUrl(`/api/admin/prospecting/maps-searches/${id}`), { cache: "no-store" });
        const data = await res.json();
        if (res.ok && data.search) {
          const d = data.search as MapsSearchDetail;
          setDetail(d);
          if (d.status === "complete" || d.status === "failed") {
            stopPoll();
            setSearching(false);
            loadPriorRuns();
            return;
          }
        }
      } catch {
        /* transient */
      }
      timer.current = setTimeout(() => poll(id), POLL_MS);
    },
    [stopPoll, loadPriorRuns],
  );

  useEffect(() => {
    if (!searchId) return;
    poll(searchId);
    return () => stopPoll();
  }, [searchId, poll, stopPoll]);

  // ---- run ----
  const handleSearch = async () => {
    setError(null);
    setSaveMsg(null);
    if (areas.length === 0) {
      setError("Add at least one area — a city, county, state, or ZIP");
      return;
    }
    if (terms.length === 0) {
      setError("Add at least one audience or business type");
      return;
    }
    setSearching(true);
    setDetail(null);
    setSelected(new Set());
    setPage(1);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/maps-search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          levers: { searchTerms: terms, areas, websiteFilter, minStars },
          max_results: maxResults,
          name: searchName.trim() || undefined,
          addons: { naming: addNaming, verify: addVerify, include_catch_all: addCatchAll, validate_catch_all: addValidateCatchAll },
          preset_slug: presetSlug || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start search");
        setSearching(false);
        return;
      }
      setSearchId(data.search_id as string);
    } catch {
      setError("Failed to start search");
      setSearching(false);
    }
  };

  // ---- import ----
  const handleImport = async () => {
    if (!detail || selected.size === 0) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/maps-save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_id: detail.id,
          google_place_ids: Array.from(selected),
          campaign_id: targetCampaign || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMsg(data.error ?? "Import failed");
      } else {
        const enr =
          data.enrichment?.status === "started"
            ? " · enrichment started"
            : data.enrichment?.status === "queued"
              ? " · enrichment queued"
              : "";
        setSaveMsg(
          `Imported ${data.inserted}${data.skipped_duplicates ? ` · ${data.skipped_duplicates} already in CRM` : ""}${enr}`,
        );
        setSelected(new Set());
        loadPriorRuns();
        refreshInCrm(results.map((r) => r.google_place_id));
      }
    } catch {
      setSaveMsg("Import failed");
    } finally {
      setSaving(false);
    }
  };

  // ---- estimate ----
  const placeCost = num(pricing?.maps?.place) || 0.004;
  const scrapeCost = num(pricing?.enrich?.site_scrape) || 0.003;
  const namingCost = num(pricing?.enrich?.naming) || 0.015;
  const catchAllCost = 0.049; // Findymail entry tier ($49/1k = $0.049/hit)
  // Findymail is pay-on-hit and only on the catch-all subset — assume ~20% of
  // leads yield a recoverable catch-all so the estimate isn't wildly overstated.
  const perLead =
    placeCost +
    scrapeCost +
    (addNaming ? namingCost + 0.004 : 0) +
    (addVerify ? 0.002 : 0) +
    (addValidateCatchAll ? catchAllCost * 0.2 : 0);
  const estTotal = maxResults * perLead;

  // ---- results view ----
  const rawResults = detail?.results ?? [];
  const results = (() => {
    if (detail?.status !== "complete" || crmTier.size === 0) return rawResults;
    return rawResults
      .map((r, i) => ({ r, i, rank: EMAIL_TIER_RANK[crmTier.get(r.google_place_id) ?? "none"] }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i)
      .map((x) => x.r);
  })();
  const pageStart = (page - 1) * RESULTS_PAGE_SIZE;
  const pageResults = results.slice(pageStart, pageStart + RESULTS_PAGE_SIZE);
  const allOnPageSelected = pageResults.length > 0 && pageResults.every((r) => selected.has(r.google_place_id));
  const inCrmCount = results.filter((r) => inCrm.has(r.google_place_id)).length;

  const dc = detail?.delivered_counts ?? {};
  const tiers = {
    personal: dc.tier_personal ?? 0,
    company: dc.tier_company ?? 0,
    catch_all: dc.tier_catch_all ?? 0,
    phone: dc.tier_phone ?? 0,
    none: dc.tier_none ?? 0,
  };
  const tierTotal = tiers.personal + tiers.company + tiers.catch_all + tiers.phone + tiers.none;

  const toggleRow = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) pageResults.forEach((r) => next.delete(r.google_place_id));
      else pageResults.forEach((r) => next.add(r.google_place_id));
      return next;
    });

  const running = detail?.status === "pending" || detail?.status === "running" || searching;
  const canRun = areas.length > 0 && terms.length > 0 && !running;

  return (
    <div className="space-y-6">
      {/* D + running cart */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* LEFT — the build */}
        <div className="min-w-0 space-y-6">
          {/* Prior searches — left column (half width) */}
          {priorRuns.length > 0 && (
            <Card className="border-border/50 shadow-sm">
              <CardHeader className="flex flex-row items-center gap-2 pb-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-500">
                  <History size={16} className="text-white" />
                </div>
                <div>
                  <CardTitle className="text-base">Prior searches</CardTitle>
                  <p className="text-xs text-muted-foreground">Click to reload cached results — no new charges.</p>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2">
                  {priorRuns.slice(0, 6).map((s) => {
                    const areaBit = s.query?.levers?.areas?.length
                      ? `${s.query.levers.areas.length} area${s.query.levers.areas.length === 1 ? "" : "s"}`
                      : s.query?.levers?.locationQuery;
                    const label =
                      s.query?.name ||
                      [s.query?.levers?.searchTerms?.join(", "), areaBit].filter(Boolean).join(" · ") ||
                      "Search";
                    const isActive = s.id === searchId;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          if (s.id === searchId) return;
                          stopPoll();
                          setDetail(null);
                          setSelected(new Set());
                          setPage(1);
                          setSaveMsg(null);
                          setError(null);
                          setSearchId(s.id);
                        }}
                        className={`w-full text-left flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${
                          isActive ? "border-indigo-400 bg-indigo-50/50" : "border-border/60 hover:bg-muted/40"
                        }`}
                      >
                        <MapPin size={16} className={s.status === "complete" ? "text-emerald-600" : s.status === "failed" ? "text-red-500" : "text-amber-500"} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{label}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.result_count} found · {s.saved_count} saved · ${num(s.cost_usd).toFixed(3)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
          {/* Presets */}
          {presets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Presets:</span>
              {presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => applyPreset(p)}
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2.5 py-1 text-xs hover:bg-muted/50 cursor-pointer"
                >
                  <Bookmark size={11} /> {p.name}
                  {p.is_global && <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">Global</Badge>}
                </button>
              ))}
            </div>
          )}

          {/* Where are your customers? */}
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <MapPin size={16} /> Where are your customers?
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Search a city, county, state, or ZIP and add it. Add as many regions as you like — we search each and
                merge the results.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              {/* Smart Search */}
              <div className="relative" ref={pickerRef}>
                <div className="relative">
                  <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={locInput}
                    onChange={(e) => {
                      setLocInput(e.target.value);
                      setGeoOpen(true);
                    }}
                    onFocus={() => setGeoOpen(true)}
                    placeholder="Try “Austin”, “Dallas County”, “Texas”, or a ZIP"
                    className="pl-9"
                  />
                  {geoLoading && <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />}
                </div>

                {geoOpen && (zipSuggestion || grouped.length > 0 || (locInput.trim().length >= 2 && !geoLoading)) && (
                  <div className="absolute z-20 mt-1 max-h-80 w-full overflow-auto rounded-lg border border-border/70 bg-background shadow-lg">
                    {zipSuggestion && (
                      <button
                        type="button"
                        onClick={() => addArea(zipSuggestion)}
                        className="flex w-full items-center gap-2 border-b border-border/40 px-3 py-2 text-left text-sm hover:bg-muted/50 cursor-pointer"
                      >
                        <Hash size={14} className="text-indigo-600" />
                        <span>
                          Add ZIP <span className="font-medium">{zipSuggestion.postalCode}</span>
                        </span>
                      </button>
                    )}
                    {grouped.map((g) => {
                      const Meta = KIND_META[g.kind];
                      return (
                        <div key={g.kind}>
                          <div className="flex items-center gap-1.5 bg-muted/40 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            <Meta.icon size={11} /> {Meta.group}
                          </div>
                          {g.rows.map((r) => (
                            <button
                              key={`${r.kind}-${r.id}`}
                              type="button"
                              onClick={() => {
                                const a = geoResultToArea(r);
                                if (a) addArea(a);
                              }}
                              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/50 cursor-pointer"
                            >
                              <span>{r.label}</span>
                              <Plus size={13} className="text-muted-foreground" />
                            </button>
                          ))}
                        </div>
                      );
                    })}
                    {!zipSuggestion && grouped.length === 0 && locInput.trim().length >= 2 && !geoLoading && (
                      <div className="px-3 py-3 text-sm text-muted-foreground">No matches. Check the spelling, or add a ZIP.</div>
                    )}
                  </div>
                )}
              </div>

              {/* Quick-add states */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">Quick add:</span>
                {QUICK_STATES.map((s) => (
                  <button
                    key={s.name}
                    type="button"
                    onClick={() => addArea({ level: "state", state: s.name, countryCode: "us", label: s.label })}
                    className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40 cursor-pointer"
                  >
                    + {s.label}
                  </button>
                ))}
              </div>

              {/* Area chips */}
              {areas.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {areas.map((a) => (
                    <span key={areaKey(a)} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-1 text-xs text-indigo-800">
                      <MapPin size={11} /> {areaLabel(a)}
                      <button type="button" onClick={() => removeArea(areaKey(a))} className="cursor-pointer">
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Who do you want? — audiences */}
          <Card className="border-border/50 shadow-sm">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Building2 size={16} /> Who are you looking for?
              </CardTitle>
              <p className="text-xs text-muted-foreground">Tap a ready-to-run audience, or type your own business type.</p>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Audience cards — whole card is the click target */}
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {AUDIENCES.map((a) => {
                  const active = audienceActive(a.terms);
                  const Icon = a.icon;
                  return (
                    <button
                      key={a.label}
                      type="button"
                      onClick={() => addAudience(a.terms)}
                      className={`group flex cursor-pointer flex-col gap-2.5 rounded-xl border p-4 text-left transition-colors ${
                        active
                          ? "border-primary bg-primary/[0.04] ring-1 ring-inset ring-primary"
                          : "border-border/70 hover:border-indigo-300"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
                          <Icon size={17} />
                        </span>
                        <span className="text-sm font-semibold leading-tight">{a.label}</span>
                      </div>
                      <p className="flex-1 text-xs leading-relaxed text-muted-foreground">{a.blurb}</p>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 size={11} /> Owner names
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <CheckCircle2 size={11} /> Verified emails
                        </span>
                      </div>
                      <span
                        className={`mt-0.5 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border text-[13px] font-medium transition-colors ${
                          active
                            ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : "border-border bg-background text-foreground group-hover:border-indigo-300 group-hover:text-primary"
                        }`}
                      >
                        {active ? (
                          <>
                            <CheckCircle2 size={14} /> Added
                          </>
                        ) : (
                          <>
                            <Plus size={14} /> Add
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Custom term */}
              <div className="space-y-2">
                <Label className="text-xs">Or add your own business type</Label>
                <Input
                  value={termInput}
                  onChange={(e) => setTermInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTerm(termInput);
                    }
                  }}
                  placeholder="Type a business type and press Enter (e.g. pilates studio)"
                />
                {terms.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {terms.map((t) => (
                      <span key={t} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700">
                        {t}
                        <button type="button" onClick={() => removeTerm(t)} className="cursor-pointer">
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Quality filters */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">Website</Label>
                  <select
                    value={websiteFilter}
                    onChange={(e) => setWebsiteFilter(e.target.value as "all" | "with" | "without")}
                    className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm cursor-pointer"
                  >
                    <option value="all">All places</option>
                    <option value="with">Only with a website</option>
                    <option value="without">Only without a website</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Min rating</Label>
                  <select
                    value={minStars}
                    onChange={(e) => setMinStars(e.target.value)}
                    className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm cursor-pointer"
                  >
                    {STAR_OPTIONS.map((s) => (
                      <option key={s.v} value={s.v}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* RIGHT — the running cart */}
        <div className="min-w-0">
          {/* Lift the cart toward the page-header row; held sticky and vertically
              centered in the viewport on scroll (lg only — see the cartRef effect). */}
          <div ref={cartRef} className="lg:sticky lg:top-6 lg:-mt-[120px] space-y-3">
            <Card className="border-indigo-200/70 shadow-md">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Rocket size={16} className="text-indigo-600" /> Your search
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Areas */}
                <CartSection label="Areas" count={areas.length} empty="Add a city, county, state, or ZIP on the left">
                  {areas.map((a) => (
                    <CartRow key={areaKey(a)} onRemove={() => removeArea(areaKey(a))}>
                      <MapPin size={12} className="shrink-0 text-indigo-500" /> {areaLabel(a)}
                    </CartRow>
                  ))}
                </CartSection>

                {/* Audiences */}
                <CartSection label="Audiences" count={terms.length} empty="Pick an audience on the left">
                  {terms.map((t) => (
                    <CartRow key={t} onRemove={() => removeTerm(t)}>
                      <Building2 size={12} className="shrink-0 text-slate-400" /> {t}
                    </CartRow>
                  ))}
                </CartSection>

                {/* Enrichment */}
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-muted-foreground">Enrichment</div>
                  <ToggleRow checked={addNaming} onChange={setAddNaming} title="Find owner names" sub="Owner/decision-maker + personal email (~$0.02/lead)" />
                  <ToggleRow checked={addVerify} onChange={setAddVerify} title="Verify emails" sub="Million Verifier every found email" />
                  <ToggleRow checked={addCatchAll} onChange={setAddCatchAll} title="Include catch-all guesses" sub="Keep the best pattern guess, flagged" />
                  <ToggleRow checked={addValidateCatchAll} onChange={setAddValidateCatchAll} title="Validate catch-all emails" sub="Recover deliverable catch-all emails via Findymail (~$0.049/hit, pay-on-hit)" />
                </div>

                {/* How many leads */}
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-muted-foreground">How many leads</div>
                  <select
                    value={maxResults}
                    onChange={(e) => setMaxResults(Number(e.target.value))}
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-sm cursor-pointer"
                  >
                    {MAX_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        Up to {m}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Outcome estimate + tier mix */}
                <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-muted-foreground">Est. cost</span>
                    <span className="text-lg font-bold tabular-nums">${estTotal.toFixed(2)}</span>
                  </div>
                  <div className="mb-2 text-right text-[10px] text-muted-foreground">~${perLead.toFixed(3)}/lead{addNaming ? " · incl. owner names" : ""}</div>
                  <TierMixBar />
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
                    <span><b className="text-slate-600">$0.05</b> record</span>
                    <span><b className="text-emerald-600">$0.10</b> company email</span>
                    <span><b className="text-indigo-600">$0.20</b> owner name</span>
                    <span><b className="text-[#2E37FE]">$0.30</b> verified personal</span>
                  </div>
                </div>

                {error && (
                  <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">
                    <AlertTriangle size={13} /> {error}
                  </div>
                )}

                <Button onClick={handleSearch} disabled={!canRun} className="w-full cursor-pointer">
                  {running ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : <Rocket size={15} className="mr-1.5" />}
                  {running ? "Searching…" : "Run search"}
                </Button>
                <div className="flex items-center justify-between">
                  <Input
                    value={searchName}
                    onChange={(e) => setSearchName(e.target.value)}
                    placeholder="Name this search (optional)"
                    className="h-8 text-xs"
                  />
                </div>
                <button type="button" onClick={saveAsPreset} className="w-full text-center text-[11px] text-muted-foreground hover:text-foreground cursor-pointer">
                  <Bookmark size={11} className="mr-1 inline" /> Save as preset
                </button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>

      {/* Progress / results (full width) */}
      {detail && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">
                {detail.status === "complete"
                  ? `${detail.result_count} businesses found`
                  : detail.status === "failed"
                    ? "Search failed"
                    : "Searching Google Maps…"}
              </CardTitle>
              <div className="text-xs text-muted-foreground">
                {detail.progress_message}
                {num(detail.cost_usd) > 0 && ` · $${num(detail.cost_usd).toFixed(3)}`}
              </div>
            </div>
            {detail.error_message && <p className="text-xs text-red-600">{detail.error_message}</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            {tierTotal > 0 && (
              <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
                <MapsOutcomeRadial tiers={tiers} total={tierTotal} verified={dc.verified_email ?? 0} />
              </div>
            )}
            {results.length > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" onClick={handleImport} disabled={saving || selected.size === 0} className="cursor-pointer">
                    {saving ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <Building2 size={14} className="mr-1.5" />}
                    Import {selected.size > 0 ? selected.size : ""} to Contacts
                  </Button>
                  <select
                    value={targetCampaign}
                    onChange={(e) => setTargetCampaign(e.target.value)}
                    className="h-8 rounded-md border border-border/60 bg-background px-2 text-xs cursor-pointer"
                  >
                    <option value="">No campaign</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {saveMsg && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-700">
                      <CheckCircle2 size={13} /> {saveMsg}
                    </span>
                  )}
                  {inCrmCount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {inCrmCount} of {results.length} already in your CRM
                    </span>
                  )}
                </div>

                <div className="overflow-x-auto rounded-md border border-border/50">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">
                          <input type="checkbox" checked={allOnPageSelected} onChange={togglePage} className="cursor-pointer" />
                        </TableHead>
                        <TableHead>Business</TableHead>
                        <TableHead>Category</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead>Website</TableHead>
                        <TableHead>Phone</TableHead>
                        <TableHead>Rating</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pageResults.map((r) => (
                        <TableRow key={r.google_place_id} className="cursor-pointer" onClick={() => toggleRow(r.google_place_id)}>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selected.has(r.google_place_id)}
                              onChange={() => toggleRow(r.google_place_id)}
                              className="cursor-pointer"
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            {r.name}
                            {inCrm.has(r.google_place_id) && (
                              <span className="ml-1.5 inline-flex items-center rounded-full bg-slate-100 px-1.5 py-0.5 align-middle text-[9px] font-medium text-slate-600">
                                In CRM
                              </span>
                            )}
                            {(() => {
                              const tier = crmTier.get(r.google_place_id);
                              if (!tier || tier === "none") return null;
                              const cls =
                                tier === "person"
                                  ? "bg-[#EDEEFF] text-[#1C24B8]"
                                  : tier === "company"
                                    ? "bg-emerald-50 text-emerald-700"
                                    : "bg-orange-50 text-orange-700";
                              const label = tier === "person" ? "Personal email" : tier === "company" ? "Company inbox" : "Catch-all";
                              return (
                                <span className={`ml-1.5 inline-flex items-center rounded-full px-1.5 py-0.5 align-middle text-[9px] font-medium ${cls}`}>
                                  {label}
                                </span>
                              );
                            })()}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.category_label ?? r.category}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{[r.city, r.state].filter(Boolean).join(", ")}</TableCell>
                          <TableCell className="text-xs">
                            {r.company_domain ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <Globe size={11} /> {r.company_domain}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.phone ? (
                              <span className="inline-flex items-center gap-1">
                                <Phone size={11} /> {r.phone}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.rating != null ? (
                              <span className="inline-flex items-center gap-0.5">
                                <Star size={11} className="text-amber-500" /> {r.rating} ({r.reviews_count ?? 0})
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>

                <PaginationControls currentPage={page} totalItems={results.length} pageSize={RESULTS_PAGE_SIZE} onPageChange={setPage} />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---- cart primitives ----
function CartSection({ label, count, empty, children }: { label: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        {label} <span className="rounded-full bg-muted px-1.5 text-[10px] tabular-nums">{count}</span>
      </div>
      {count === 0 ? (
        <p className="rounded-md border border-dashed border-border/60 px-2.5 py-2 text-[11px] text-muted-foreground">{empty}</p>
      ) : (
        <div className="space-y-1">{children}</div>
      )}
    </div>
  );
}

function CartRow({ children, onRemove }: { children: React.ReactNode; onRemove: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-xs">
      <span className="inline-flex min-w-0 items-center gap-1.5 truncate">{children}</span>
      <button type="button" onClick={onRemove} className="shrink-0 text-muted-foreground hover:text-foreground cursor-pointer">
        <X size={12} />
      </button>
    </div>
  );
}

function ToggleRow({ checked, onChange, title, sub }: { checked: boolean; onChange: (v: boolean) => void; title: string; sub: string }) {
  return (
    <label className="flex items-start gap-2 rounded-md px-1 py-1 text-xs cursor-pointer hover:bg-muted/30">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 cursor-pointer" />
      <span>
        <span className="font-medium">{title}</span>
        <span className="block text-[10px] text-muted-foreground">{sub}</span>
      </span>
    </label>
  );
}

// Illustrative tier-mix bar for the pre-run estimate (the outcome tiers the
// pricing bills, NOT a business-count prediction — counts are deliberately never
// shown pre-run). The real mix renders as the radial once a run completes.
function TierMixBar() {
  const segs = [
    { color: "#94a3b8", w: 20 },
    { color: "#10b981", w: 30 },
    { color: "#6366f1", w: 25 },
    { color: "#2E37FE", w: 25 },
  ];
  return (
    <div className="flex h-2 overflow-hidden rounded-full">
      {segs.map((s, i) => (
        <div key={i} style={{ width: `${s.w}%`, background: s.color }} />
      ))}
    </div>
  );
}

// Delivered-outcome radial for a completed search (self-contained; segments match
// the tiered price card the estimate shows).
function MapsOutcomeRadial({
  tiers,
  total,
  verified,
}: {
  tiers: { personal: number; company: number; catch_all: number; phone: number; none: number };
  total: number;
  verified: number;
}) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const segs = [
    { key: "personal", v: tiers.personal, color: "#2E37FE", label: "Personal email" },
    { key: "company", v: tiers.company, color: "#10b981", label: "Company inbox" },
    { key: "catch_all", v: tiers.catch_all, color: "#f97316", label: "Catch-all guess" },
    { key: "phone", v: tiers.phone, color: "#f59e0b", label: "Phone only" },
    { key: "none", v: tiers.none, color: "#94a3b8", label: "No contact info" },
  ];
  const withEmail = tiers.personal + tiers.company;
  let acc = 0;
  return (
    <div className="flex items-center gap-5">
      <div className="relative h-[96px] w-[96px] shrink-0">
        <svg width="96" height="96" viewBox="0 0 88 88" className="-rotate-90">
          <circle cx="44" cy="44" r={R} fill="none" stroke="#f1f5f9" strokeWidth="10" />
          {total > 0 &&
            segs.map((s) => {
              const frac = s.v / total;
              if (frac <= 0) return null;
              const len = frac * C;
              const off = acc;
              acc += len;
              return (
                <circle
                  key={s.key}
                  cx="44"
                  cy="44"
                  r={R}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="10"
                  strokeDasharray={`${len} ${C - len}`}
                  strokeDashoffset={-off}
                  style={{ transition: "stroke-dasharray .4s ease" }}
                />
              );
            })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[20px] font-bold leading-none tabular-nums">{withEmail}</span>
          <span className="text-[9px] leading-tight text-muted-foreground">of {total}</span>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <p className="mb-1.5 text-[12px] font-semibold">Delivered outcomes</p>
        <div className="space-y-0.5">
          {segs.map((s) => (
            <div key={s.key} className="flex items-center gap-2 border-b border-dashed border-border/60 py-[3px] text-[11.5px] last:border-b-0">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-mono font-semibold tabular-nums">{s.v}</span>
            </div>
          ))}
        </div>
        {verified > 0 && <p className="mt-1 text-[10px] text-muted-foreground">{verified} personal verified clean (Million Verifier)</p>}
      </div>
    </div>
  );
}
