"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { createClient } from "@/lib/supabase/client";
import type { MapsPlace, MapsSearchStatus } from "@/types/app";

// The Google Maps prospecting vein — self-contained sibling of LinkedInSearchPanel.
// Sources businesses by niche + location via the compass actor, streams results,
// and imports selected leads into Contacts (auto-enriched: site scrape → generic
// email + phone; owner-name add-on → decision-maker name → personal email).

const POLL_MS = 3000;
const RESULTS_PAGE_SIZE = 25;

// Common FB-group niches for quick-add. Each is a Google Maps search term.
const NICHE_PACKS: { label: string; terms: string[] }[] = [
  { label: "Med spas", terms: ["med spa", "medical spa"] },
  { label: "Dentists", terms: ["dentist", "dental clinic"] },
  { label: "Chiropractors", terms: ["chiropractor"] },
  { label: "HVAC", terms: ["hvac contractor", "air conditioning repair"] },
  { label: "Roofers", terms: ["roofing contractor"] },
  { label: "Plumbers", terms: ["plumber"] },
  { label: "Commercial cleaning", terms: ["commercial cleaning service", "janitorial service"] },
  { label: "Law firms", terms: ["law firm", "attorney"] },
  { label: "Gyms & studios", terms: ["gym", "fitness studio"] },
  { label: "Auto repair", terms: ["auto repair shop"] },
  { label: "Landscaping", terms: ["landscaping service"] },
  { label: "Real estate", terms: ["real estate agency"] },
];

const MAX_OPTIONS = [100, 250, 500, 1000];
const STAR_OPTIONS = [
  { v: "", label: "Any rating" },
  { v: "3.5", label: "3.5★ +" },
  { v: "4.0", label: "4.0★ +" },
  { v: "4.5", label: "4.5★ +" },
];

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
  query: { name?: string; levers?: { searchTerms?: string[]; locationQuery?: string } } | null;
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

export function MapsSearchPanel() {
  // Form state.
  const [searchTerms, setSearchTerms] = useState<string[]>([]);
  const [termInput, setTermInput] = useState("");
  const [location, setLocation] = useState("");
  const [websiteFilter, setWebsiteFilter] = useState<"all" | "with" | "without">("all");
  const [minStars, setMinStars] = useState("");
  const [maxResults, setMaxResults] = useState(250);
  const [addNaming, setAddNaming] = useState(false);
  const [addVerify, setAddVerify] = useState(false);
  const [searchName, setSearchName] = useState("");

  // Search run state.
  const [searchId, setSearchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MapsSearchDetail | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Results + import.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [targetCampaign, setTargetCampaign] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // Presets + pricing + prior runs.
  const [presets, setPresets] = useState<Preset[]>([]);
  const [priorRuns, setPriorRuns] = useState<PriorRun[]>([]);
  const [pricing, setPricing] = useState<LivePricing | null>(null);
  // Provenance: which preset (if any) this search was started from.
  const [presetSlug, setPresetSlug] = useState<string | null>(null);
  // Places already saved as contacts (keyed by google_place_id) — compass has no
  // server-side blacklist, so re-pulling a niche re-pays for places you already
  // own; this flag makes the overlap visible before you import (or re-search).
  const [inCrm, setInCrm] = useState<Set<string>>(new Set());

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

  // Which of the current results are already contacts (chunked RLS-scoped read).
  const refreshInCrm = useCallback(async (ids: string[]) => {
    if (ids.length === 0) {
      setInCrm(new Set());
      return;
    }
    try {
      const supabase = createClient();
      const found = new Set<string>();
      for (let i = 0; i < ids.length; i += 300) {
        const { data } = await supabase
          .from("contacts")
          .select("google_place_id")
          .in("google_place_id", ids.slice(i, i + 300));
        for (const r of (data as { google_place_id: string | null }[] | null) ?? []) {
          if (r.google_place_id) found.add(r.google_place_id);
        }
      }
      setInCrm(found);
    } catch {
      /* non-fatal — flags just don't show */
    }
  }, []);

  // Re-check when the result set changes (streaming growth or a loaded prior run).
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

  // ---- term chips ----
  const addTerm = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    setSearchTerms((prev) => (prev.some((x) => x.toLowerCase() === t.toLowerCase()) ? prev : [...prev, t]));
    setTermInput("");
  };
  const removeTerm = (t: string) => setSearchTerms((prev) => prev.filter((x) => x !== t));
  const addPack = (terms: string[]) =>
    setSearchTerms((prev) => {
      const lower = new Set(prev.map((x) => x.toLowerCase()));
      return [...prev, ...terms.filter((t) => !lower.has(t.toLowerCase()))];
    });

  // ---- presets ----
  const applyPreset = (p: Preset) => {
    const c = p.config ?? {};
    setSearchTerms(Array.isArray(c.searchTerms) ? c.searchTerms : []);
    setWebsiteFilter(c.websiteFilter ?? "all");
    setMinStars(c.minStars ?? "");
    setAddNaming(Boolean(c.addNaming));
    setAddVerify(Boolean(c.addVerify));
    if (typeof c.maxResults === "number") setMaxResults(c.maxResults);
    if (!searchName) setSearchName(p.name);
    setPresetSlug(p.slug);
  };

  const saveAsPreset = async () => {
    const name = window.prompt("Save this niche as a preset. Name:", searchName || searchTerms[0] || "");
    if (!name) return;
    const config: MapsConfig = { searchTerms, websiteFilter, minStars, addNaming, addVerify, maxResults };
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

  // ---- search ----
  const handleSearch = async () => {
    setError(null);
    setSaveMsg(null);
    if (searchTerms.length === 0) {
      setError("Add at least one niche / business type");
      return;
    }
    if (!location.trim()) {
      setError("Add a location (city + state, or a state)");
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
          levers: { searchTerms, locationQuery: location.trim(), websiteFilter, minStars },
          max_results: maxResults,
          name: searchName.trim() || undefined,
          addons: { naming: addNaming, verify: addVerify },
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
  const perLead = placeCost + scrapeCost + (addNaming ? namingCost + 0.004 : 0) + (addVerify ? 0.002 : 0);
  const estTotal = maxResults * perLead;

  const results = detail?.results ?? [];
  const pageStart = (page - 1) * RESULTS_PAGE_SIZE;
  const pageResults = results.slice(pageStart, pageStart + RESULTS_PAGE_SIZE);
  const allOnPageSelected = pageResults.length > 0 && pageResults.every((r) => selected.has(r.google_place_id));
  const inCrmCount = results.filter((r) => inCrm.has(r.google_place_id)).length;

  // Delivered-outcome radial data (the ledger's exclusive best-tier buckets,
  // stamped by the enrichment run at completion — empty until leads from this
  // search finish enriching).
  const dc = detail?.delivered_counts ?? {};
  const tiers = {
    personal: dc.tier_personal ?? 0,
    company: dc.tier_company ?? 0,
    phone: dc.tier_phone ?? 0,
    none: dc.tier_none ?? 0,
  };
  const tierTotal = tiers.personal + tiers.company + tiers.phone + tiers.none;

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

  return (
    <div className="space-y-6">
      {/* Prior runs */}
      {priorRuns.length > 0 && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-500">
              <History size={16} className="text-white" />
            </div>
            <div>
              <CardTitle className="text-base">Prior Maps searches</CardTitle>
              <p className="text-xs text-muted-foreground">Click to reload cached results — no new Apify charges.</p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {priorRuns.slice(0, 8).map((s) => {
                const label =
                  s.query?.name ||
                  [s.query?.levers?.searchTerms?.join(", "), s.query?.levers?.locationQuery]
                    .filter(Boolean)
                    .join(" · ") ||
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
                    <MapIconInline status={s.status} />
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

      {/* Search form */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin size={16} /> Google Maps business search
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Find SMBs by niche + location. They import with a company email + phone; add owner-name discovery to build
            the decision-maker&apos;s personal email.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
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

          {/* Niche terms */}
          <div className="space-y-2">
            <Label className="text-xs">Niche / business type</Label>
            <div className="flex flex-wrap gap-1.5">
              {searchTerms.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-1 text-xs text-indigo-800">
                  {t}
                  <button type="button" onClick={() => removeTerm(t)} className="cursor-pointer">
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
            <Input
              value={termInput}
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTerm(termInput);
                }
              }}
              placeholder="Type a business type and press Enter (e.g. med spa)"
            />
            <div className="flex flex-wrap gap-1.5">
              {NICHE_PACKS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => addPack(p.terms)}
                  className="rounded-full border border-dashed border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/40 cursor-pointer"
                >
                  + {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Location + filters */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Location (city + state, or state)</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Austin, TX" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Search name (optional)</Label>
              <Input value={searchName} onChange={(e) => setSearchName(e.target.value)} placeholder="Austin med spas" />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
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
            <div className="space-y-1.5">
              <Label className="text-xs">Max results</Label>
              <select
                value={maxResults}
                onChange={(e) => setMaxResults(Number(e.target.value))}
                className="h-9 w-full rounded-md border border-border/60 bg-background px-2 text-sm cursor-pointer"
              >
                {MAX_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Add-ons */}
          <div className="rounded-lg border border-border/60 bg-muted/20 p-3 space-y-2">
            <div className="text-xs font-medium text-muted-foreground">Enrichment add-ons</div>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={addNaming} onChange={(e) => setAddNaming(e.target.checked)} className="mt-0.5 cursor-pointer" />
              <span>
                <span className="font-medium">Find owner names</span>
                <span className="block text-xs text-muted-foreground">
                  Discover the owner/decision-maker&apos;s name &amp; title, then build their personal email (~$0.02/lead).
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="checkbox" checked={addVerify} onChange={(e) => setAddVerify(e.target.checked)} className="mt-0.5 cursor-pointer" />
              <span>
                <span className="font-medium">Verify emails</span>
                <span className="block text-xs text-muted-foreground">Million Verifier every found email before it&apos;s used.</span>
              </span>
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle size={14} /> {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSearch} disabled={running} className="cursor-pointer">
              {running ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : <Search size={15} className="mr-1.5" />}
              {running ? "Searching…" : "Search Google Maps"}
            </Button>
            <Button variant="outline" onClick={saveAsPreset} className="cursor-pointer">
              <Bookmark size={14} className="mr-1.5" /> Save as preset
            </Button>
            <span className="text-xs text-muted-foreground">
              Est. ~${estTotal.toFixed(2)} for {maxResults} leads (~${perLead.toFixed(3)}/lead)
              {addNaming ? " · incl. owner names" : ""}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Progress / results */}
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
            {detail.error_message && (
              <p className="text-xs text-red-600">{detail.error_message}</p>
            )}
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
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.category_label ?? r.category}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {[r.city, r.state].filter(Boolean).join(", ")}
                          </TableCell>
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

                <PaginationControls
                  currentPage={page}
                  totalItems={results.length}
                  pageSize={RESULTS_PAGE_SIZE}
                  onPageChange={setPage}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MapIconInline({ status }: { status: MapsSearchStatus }) {
  const color =
    status === "complete"
      ? "text-emerald-600"
      : status === "failed"
        ? "text-red-500"
        : "text-amber-500";
  return <MapPin size={16} className={color} />;
}

// Delivered-outcome radial for a search's imported leads: what tier each lead
// actually reached after enrichment (the ledger's exclusive buckets — also the
// units the outcome-tiered pricing bills). Same donut idiom as the LinkedIn
// panel's EmailOutcomeRadial; segments match the tiered price card.
function MapsOutcomeRadial({
  tiers,
  total,
  verified,
}: {
  tiers: { personal: number; company: number; phone: number; none: number };
  total: number;
  verified: number;
}) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const segs = [
    { key: "personal", v: tiers.personal, color: "#2E37FE", label: "Personal email" },
    { key: "company", v: tiers.company, color: "#10b981", label: "Company inbox" },
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
            <div
              key={s.key}
              className="flex items-center gap-2 border-b border-dashed border-border/60 py-[3px] text-[11.5px] last:border-b-0"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-mono font-semibold tabular-nums">{s.v}</span>
            </div>
          ))}
        </div>
        {verified > 0 && (
          <p className="mt-1 text-[10px] text-muted-foreground">{verified} personal verified clean (Million Verifier)</p>
        )}
      </div>
    </div>
  );
}
