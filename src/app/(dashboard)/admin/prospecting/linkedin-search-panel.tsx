"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  UserSearch,
  Search,
  Loader2,
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  Send,
  ExternalLink,
  Info,
  HelpCircle,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { createClient } from "@/lib/supabase/client";
import type { LinkedInProspect, LinkedInSearchStatus } from "@/types/app";
import {
  HEADCOUNTS,
  SENIORITY_LEVELS,
  FUNCTIONS,
  INDUSTRIES,
} from "@/lib/apify/sourcing/linkedin-facets";

type Depth = "short" | "full" | "full_email";

const DEPTHS: { value: Depth; label: string; hint: string; rate: number }[] = [
  { value: "short", label: "Short", hint: "cheapest · basic profile", rate: 0.002 },
  { value: "full", label: "Full", hint: "opens each profile", rate: 0.01 },
  { value: "full_email", label: "Full + email", hint: "adds an email search", rate: 0.012 },
];

// Per-person enrichment rates (the Contacts waterfall), for the cost breakdown.
// Actors: profile-scraper (email), linkedin-company (domain), vdrmota (2nd pass),
// profile-posts (activity); verify is Million Verifier (not Apify).
const ENRICH_RATES = {
  email: 0.01,
  domain: 0.004,
  waterfall: 0.005,
  activity: 0.005,
  verify: 0.0006,
};

const MAX_OPTIONS = [100, 250, 500, 1000] as const;
const POLL_MS = 3000;
const PAGE_SIZE = 25;

type Preset = {
  name: string;
  titles?: string[];
  seniority?: string[];
  functions?: string[];
  industries?: string[];
};

// Quick-start ICP templates. Codes reference the verified facet taxonomy:
// seniority 220=Director 300=VP 310=CXO 320=Owner, function 18=Operations
// 25=Sales, industry 4=Software Development.
const PRESETS: Preset[] = [
  {
    name: "Facilities decision-makers",
    titles: ["Facilities Manager", "Director of Facilities", "VP Operations"],
    seniority: ["220", "300"],
    functions: ["18"],
  },
  {
    name: "SaaS founders & C-suite",
    titles: ["Founder", "CEO", "Co-Founder"],
    seniority: ["310", "320"],
    industries: ["4"],
  },
  {
    name: "Sales / RevOps leaders",
    titles: ["VP Sales", "Head of Sales", "Revenue Operations"],
    seniority: ["220", "300"],
    functions: ["25"],
  },
];

type SearchDetail = {
  id: string;
  results: LinkedInProspect[];
  result_count: number;
  target_max_results: number;
  truncated: boolean;
  status: LinkedInSearchStatus;
  progress_message: string | null;
  error_message: string | null;
  cost_usd: number | string;
};

type Campaign = { id: string; name: string };

function ChipInput({
  placeholder,
  values,
  onChange,
}: {
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-input bg-transparent px-2 py-1.5"
      style={{ minHeight: 38 }}
    >
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded-md bg-[#EDEEFF] px-2 py-0.5 text-[12px] font-medium text-[#1C24B8]"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="cursor-pointer text-[#1C24B8]/60 hover:text-[#1C24B8]"
            aria-label={`Remove ${v}`}
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={add}
        placeholder={values.length ? "" : placeholder}
        className="min-w-[120px] flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </div>
  );
}

function FacetMultiSelect({
  options,
  selected,
  onChange,
  searchable = false,
}: {
  options: { value: string; label: string }[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  searchable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const filtered =
    searchable && q.trim()
      ? options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()))
      : options;
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange(next);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg border border-input bg-transparent px-2.5 text-sm"
        style={{ height: 38 }}
      >
        <span className={selected.size ? "text-foreground" : "text-muted-foreground"}>
          {selected.size ? `${selected.size} selected` : "Any"}
        </span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-[42px] z-30 w-full rounded-lg border border-border bg-background p-1 shadow-md">
          {searchable && (
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="mb-1 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm outline-none focus:border-[#2E37FE]"
            />
          )}
          <div className="max-h-56 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-2 py-1.5 text-[12px] text-muted-foreground">No matches</p>
            ) : (
              filtered.map((o) => (
                <label
                  key={o.value}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(o.value)}
                    onChange={() => toggle(o.value)}
                    className="accent-[#2E37FE]"
                  />
                  {o.label}
                </label>
              ))
            )}
          </div>
          {selected.size > 0 && (
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="mt-1 w-full rounded-md px-2 py-1 text-left text-[12px] text-[#2E37FE] hover:bg-muted"
            >
              Clear ({selected.size})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function LinkedInSearchPanel() {
  // Levers
  const [query, setQuery] = useState("");
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>(["United States"]);
  const [headcount, setHeadcount] = useState<Set<string>>(new Set());
  const [recentlyChanged, setRecentlyChanged] = useState(false);
  const [activePosters, setActivePosters] = useState(false);
  const [depth, setDepth] = useState<Depth>("short");
  const [maxResults, setMaxResults] = useState<number>(250);
  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [estimateInfoOpen, setEstimateInfoOpen] = useState(false);
  const [depthInfoOpen, setDepthInfoOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [excludeTitles, setExcludeTitles] = useState<string[]>([]);
  const [currentCompanies, setCurrentCompanies] = useState<string[]>([]);
  const [seniority, setSeniority] = useState<Set<string>>(new Set());
  const [functions, setFunctions] = useState<Set<string>>(new Set());
  const [industries, setIndustries] = useState<Set<string>>(new Set());

  // Run state
  const [searchId, setSearchId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Results selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  // Save → campaign
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [targetCampaign, setTargetCampaign] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load the org's campaigns for the "Add to campaign" picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("campaigns")
        .select("id, name")
        .order("created_at", { ascending: false });
      if (!cancelled && data) setCampaigns(data as Campaign[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const stopPoll = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(appUrl(`/api/admin/prospecting/linkedin-searches/${id}`), {
          cache: "no-store",
        });
        const data = await res.json();
        if (res.ok && data.search) {
          const d = data.search as SearchDetail;
          setDetail(d);
          if (d.status === "complete" || d.status === "failed") {
            stopPoll();
            return;
          }
        }
      } catch {
        // transient — keep polling
      }
      timer.current = setTimeout(() => poll(id), POLL_MS);
    },
    [stopPoll],
  );

  useEffect(() => {
    if (!searchId) return;
    poll(searchId);
    return () => stopPoll();
  }, [searchId, poll, stopPoll]);

  const buildLevers = () => {
    const levers: Record<string, unknown> = {};
    if (query.trim()) levers.query = query.trim();
    if (jobTitles.length) levers.currentJobTitles = jobTitles;
    if (excludeTitles.length) levers.excludeCurrentJobTitles = excludeTitles;
    if (locations.length) levers.locations = locations;
    if (headcount.size) levers.companyHeadcount = Array.from(headcount);
    if (currentCompanies.length) levers.currentCompanies = currentCompanies;
    if (seniority.size) levers.seniorityLevelIds = Array.from(seniority);
    if (functions.size) levers.functionIds = Array.from(functions);
    if (industries.size) levers.industryIds = Array.from(industries);
    if (recentlyChanged) levers.recentlyChangedJobs = true;
    if (activePosters) levers.recentlyPostedOnLinkedIn = true;
    return levers;
  };

  const applyPreset = (p: Preset) => {
    setJobTitles(p.titles ?? []);
    setSeniority(new Set(p.seniority ?? []));
    setFunctions(new Set(p.functions ?? []));
    setIndustries(new Set(p.industries ?? []));
    setTipsOpen(false);
  };

  const hasConstraint =
    query.trim().length > 0 ||
    jobTitles.length > 0 ||
    locations.length > 0 ||
    headcount.size > 0 ||
    currentCompanies.length > 0 ||
    seniority.size > 0 ||
    functions.size > 0 ||
    industries.size > 0;

  const handleSearch = async () => {
    setError(null);
    setSaveMsg(null);
    setStarting(true);
    stopPoll();
    setDetail(null);
    setSelected(new Set());
    setPage(1);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/linkedin-search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levers: buildLevers(), depth, max_results: maxResults }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to start search");
        setStarting(false);
        return;
      }
      setSearchId(data.search_id as string);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start search");
    } finally {
      setStarting(false);
    }
  };

  const results = detail?.results ?? [];
  const isComplete = detail?.status === "complete";
  const isRunning = detail?.status === "running" || detail?.status === "pending";
  const isFailed = detail?.status === "failed";

  const pageResults = useMemo(
    () => results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [results, page],
  );
  const pageKeys = pageResults.map((r) => r.linkedin_url).filter(Boolean) as string[];
  const allPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));

  const toggleRow = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };
  const togglePage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageKeys.forEach((k) => next.delete(k));
      else pageKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  const depthMeta = DEPTHS.find((d) => d.value === depth);
  const rate = depthMeta?.rate ?? 0.002;
  const estimate = rate * maxResults;
  const activityRate = activePosters ? 0 : ENRICH_RATES.activity;
  const perPersonEnrich =
    ENRICH_RATES.email + ENRICH_RATES.domain + ENRICH_RATES.waterfall + activityRate + ENRICH_RATES.verify;
  const projectedTotal = estimate + perPersonEnrich * maxResults;

  const handleSave = async () => {
    if (!searchId || selected.size === 0) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/linkedin-save"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_id: searchId,
          linkedin_urls: Array.from(selected),
          campaign_id: targetCampaign || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSaveMsg(data.error ?? "Save failed");
        setSaving(false);
        return;
      }
      const camp = campaigns.find((c) => c.id === targetCampaign);
      setSaveMsg(
        `Imported ${data.inserted} to Contacts${camp ? ` · added to ${camp.name}` : ""}` +
          (data.skipped_duplicates ? ` · ${data.skipped_duplicates} already existed` : ""),
      );
      setSelected(new Set());
      setAddOpen(false);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Search form */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
              <UserSearch size={16} className="text-white" />
            </div>
            <div>
              <CardTitle className="text-base">Find people on LinkedIn</CardTitle>
              <p className="text-xs text-muted-foreground">
                Source new people by ICP. Selected people import into Contacts, where the waterfall finds + verifies their email.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTipsOpen((v) => !v)}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-[#2E37FE] hover:bg-[#EDEEFF]/50"
          >
            <HelpCircle size={14} />
            How to search
          </button>
        </CardHeader>
        <CardContent className="space-y-4">
          {tipsOpen && (
            <div className="space-y-2 rounded-lg border border-[#2E37FE]/20 bg-[#EDEEFF]/40 p-3 text-[12px] text-slate-600">
              <p className="text-[13px] font-medium text-slate-900">How to search</p>
              <ul className="list-disc space-y-1 pl-4">
                <li>
                  <span className="font-medium text-slate-800">Multiple values:</span> in Job titles and Locations, type a value and press Enter (or comma) to add several — results match <span className="font-medium">any</span> of them. e.g. VP Sales, Head of Sales, CRO.
                </li>
                <li>
                  <span className="font-medium text-slate-800">Seniority · Function · Industry</span> are multi-select (Industry is searchable) — pick as many as apply.
                </li>
                <li>
                  <span className="font-medium text-slate-800">Keywords</span> is a fuzzy free-text search across the whole profile — the broadest lever. It supports LinkedIn operators: an &ldquo;exact phrase&rdquo; in quotes, plus AND / OR / NOT — e.g. facilities AND (director OR manager).
                </li>
                <li>
                  <span className="font-medium text-slate-800">For precise, non-wildcard targeting,</span> lean on the facets (they map to LinkedIn&apos;s own codes) over Keywords. Company size and the timing toggles narrow further.
                </li>
              </ul>
              <div className="pt-0.5">
                <p className="mb-1 text-[13px] font-medium text-slate-900">Quick-start presets</p>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className="cursor-pointer rounded-md border border-[#2E37FE]/40 bg-white px-2.5 py-1 text-[12px] font-medium text-[#1C24B8] hover:bg-[#EDEEFF]"
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Keywords</Label>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. facilities, founder, RevOps"
                style={{ height: 38 }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Job titles</Label>
              <ChipInput
                placeholder="Type a title, press Enter"
                values={jobTitles}
                onChange={setJobTitles}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Locations</Label>
              <ChipInput
                placeholder="e.g. United States, California, Chicago"
                values={locations}
                onChange={setLocations}
              />
              <p className="text-[11px] text-muted-foreground">
                Country, state/region, or city — LinkedIn has no zip or county. Use full names (&ldquo;United Kingdom&rdquo;, not &ldquo;UK&rdquo;).
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Company size</Label>
              <div className="flex flex-wrap gap-1">
                {HEADCOUNTS.map((h) => {
                  const on = headcount.has(h.value);
                  return (
                    <button
                      key={h.value}
                      type="button"
                      title={h.label}
                      onClick={() =>
                        setHeadcount((prev) => {
                          const next = new Set(prev);
                          if (next.has(h.value)) next.delete(h.value);
                          else next.add(h.value);
                          return next;
                        })
                      }
                      className={`cursor-pointer rounded-md border px-2 py-1 text-[12px] transition-colors ${
                        on
                          ? "border-[#2E37FE] bg-[#2E37FE] text-white"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      {h.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Seniority</Label>
              <FacetMultiSelect options={SENIORITY_LEVELS} selected={seniority} onChange={setSeniority} />
            </div>
            <div className="space-y-1.5">
              <Label>Function</Label>
              <FacetMultiSelect options={FUNCTIONS} selected={functions} onChange={setFunctions} searchable />
            </div>
            <div className="space-y-1.5">
              <Label>Industry</Label>
              <FacetMultiSelect options={INDUSTRIES} selected={industries} onChange={setIndustries} searchable />
            </div>
          </div>

          {/* Timing toggles */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setRecentlyChanged((v) => !v)}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                recentlyChanged
                  ? "border-[#2E37FE] bg-[#EDEEFF] text-[#1C24B8]"
                  : "border-border hover:bg-muted"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${recentlyChanged ? "bg-[#2E37FE]" : "bg-slate-300"}`} />
              New in role · 90d
            </button>
            <button
              type="button"
              onClick={() => setActivePosters((v) => !v)}
              className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                activePosters
                  ? "border-[#2E37FE] bg-[#EDEEFF] text-[#1C24B8]"
                  : "border-border hover:bg-muted"
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${activePosters ? "bg-[#2E37FE]" : "bg-slate-300"}`} />
              Active on LinkedIn · 30d
            </button>
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 text-sm font-medium text-[#2E37FE]"
            >
              <ChevronDown
                size={15}
                className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
              Advanced filters
            </button>
            {advancedOpen && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Exclude job titles</Label>
                  <ChipInput
                    placeholder="Titles to skip"
                    values={excludeTitles}
                    onChange={setExcludeTitles}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Current company (LinkedIn URL)</Label>
                  <ChipInput
                    placeholder="linkedin.com/company/…"
                    values={currentCompanies}
                    onChange={setCurrentCompanies}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Depth + volume + search */}
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="flex flex-wrap gap-4">
              <div className="space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <Label>Depth</Label>
                  <button
                    type="button"
                    onClick={() => setDepthInfoOpen((v) => !v)}
                    aria-label="What does depth mean?"
                    aria-expanded={depthInfoOpen}
                    className="cursor-pointer text-muted-foreground transition-colors hover:text-[#2E37FE]"
                  >
                    <Info size={13} />
                  </button>
                </div>
                <div className="flex gap-1">
                  {DEPTHS.map((d) => (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => setDepth(d.value)}
                      title={d.hint}
                      className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                        depth === d.value
                          ? "border-[#2E37FE] bg-[#2E37FE] text-white"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Max people</Label>
                <div className="flex items-center gap-1">
                  <input
                    type="number"
                    min={1}
                    max={2500}
                    value={maxResults}
                    onChange={(e) => {
                      const v = parseInt(e.target.value || "0", 10);
                      setMaxResults(Math.max(1, Math.min(2500, Number.isFinite(v) ? v : 1)));
                    }}
                    aria-label="Custom max people (up to 2,500)"
                    title="Custom — up to 2,500"
                    className="w-[74px] rounded-md border border-border bg-background px-2 py-1 text-[12px] tabular-nums outline-none focus:border-[#2E37FE]"
                  />
                  {MAX_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setMaxResults(n)}
                      className={`cursor-pointer rounded-md border px-2.5 py-1 text-[12px] transition-colors ${
                        maxResults === n
                          ? "border-[#2E37FE] bg-[#2E37FE] text-white"
                          : "border-border bg-background hover:bg-muted"
                      }`}
                    >
                      {n.toLocaleString()}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex flex-col items-start gap-1.5 sm:items-end">
              <Button
                onClick={handleSearch}
                disabled={starting || isRunning || !hasConstraint}
                style={{ background: "#2E37FE" }}
                className="text-white"
              >
                {starting || isRunning ? (
                  <Loader2 size={16} className="mr-1.5 animate-spin" />
                ) : (
                  <Search size={16} className="mr-1.5" />
                )}
                {isRunning ? "Searching…" : `Search ${maxResults.toLocaleString()}`}
              </Button>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-muted-foreground">est. ~${estimate.toFixed(2)}</span>
                <button
                  type="button"
                  onClick={() => setEstimateInfoOpen((v) => !v)}
                  aria-label="How is this estimated?"
                  aria-expanded={estimateInfoOpen}
                  className="cursor-pointer text-muted-foreground transition-colors hover:text-[#2E37FE]"
                >
                  <Info size={14} />
                </button>
              </div>
            </div>
          </div>

          {depthInfoOpen && (
            <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3 text-[12px] text-muted-foreground">
              <p className="font-medium text-foreground">What &ldquo;Depth&rdquo; controls — how deep the actor reads each result</p>
              <p>
                <span className="font-medium text-foreground">Short</span> — reads only the search-result pages: name, headline, company, location, profile URL. Cheapest, no email. Best when you&apos;ll enrich the keepers afterward.
              </p>
              <p>
                <span className="font-medium text-foreground">Full</span> — opens every profile for full detail (about, experience, education). Richer data, higher cost.
              </p>
              <p>
                <span className="font-medium text-foreground">Full + email</span> — Full, plus an email lookup per profile (≈ $10 / 1k). Only worth it if you&apos;re <em>not</em> running the enrichment waterfall afterward.
              </p>
              <p>
                Default is Short: the waterfall finds emails on just the people you keep, so you don&apos;t pay the email premium on people you&apos;ll discard.
              </p>
            </div>
          )}

          {estimateInfoOpen && (
            <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3 text-[12px] text-muted-foreground">
              <p className="font-medium text-foreground">Cost by stage &amp; actor</p>

              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
                  Sourcing · this search (up to {maxResults.toLocaleString()})
                </p>
                <div className="mt-1 flex items-center justify-between">
                  <span>
                    Search · <span className="font-mono">profile-search</span> ({depthMeta?.label})
                  </span>
                  <span className="font-mono tabular-nums">
                    ${rate.toFixed(4)} × {maxResults.toLocaleString()} = ${estimate.toFixed(2)}
                  </span>
                </div>
              </div>

              <div>
                <p className="text-[10.5px] font-semibold uppercase tracking-wide text-slate-500">
                  Enrichment · per person you import (runs in Contacts)
                </p>
                <div className="mt-1 space-y-0.5">
                  <div className="flex items-center justify-between">
                    <span>Profile → email · <span className="font-mono">profile-scraper</span></span>
                    <span className="font-mono tabular-nums">${ENRICH_RATES.email.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Company → domain · <span className="font-mono">linkedin-company</span></span>
                    <span className="font-mono tabular-nums">${ENRICH_RATES.domain.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>2nd-pass email · <span className="font-mono">vdrmota</span> (misses)</span>
                    <span className="font-mono tabular-nums">${ENRICH_RATES.waterfall.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>
                      Activity · <span className="font-mono">profile-posts</span>
                      {activePosters ? " (skipped)" : ""}
                    </span>
                    <span className="font-mono tabular-nums">${activityRate.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>Verify · Million Verifier</span>
                    <span className="font-mono tabular-nums">${ENRICH_RATES.verify.toFixed(4)}</span>
                  </div>
                  <div className="flex items-center justify-between border-t border-border/60 pt-0.5 font-medium text-foreground">
                    <span>per imported person (max)</span>
                    <span className="font-mono tabular-nums">${perPersonEnrich.toFixed(4)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md bg-[#EDEEFF]/70 px-2 py-1.5 font-medium text-foreground">
                <span>Projected total if you import + enrich all {maxResults.toLocaleString()}</span>
                <span className="font-mono tabular-nums">~${projectedTotal.toFixed(2)}</span>
              </div>

              <p className="text-[11px]">
                A ceiling, not a bill: sourcing charges only for profiles the actor can return; enrichment bills only on people you actually import (usually a subset), and each waterfall pass only touches people the previous one left without an email. Verification runs once, at first send. Short-mode search pricing is confirmed on the first live run.
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          )}
          {!hasConstraint && (
            <p className="text-[11px] text-muted-foreground">
              Add at least a keyword, job title, or location to search.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Progress banner */}
      {detail && (isRunning || isFailed) && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm ${
            isFailed
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-blue-200 bg-blue-50 text-blue-800"
          }`}
        >
          {isFailed ? (
            <XCircle size={16} className="text-red-500" />
          ) : (
            <Loader2 size={16} className="animate-spin text-blue-600" />
          )}
          <span>
            {isFailed
              ? detail.error_message ?? "Search failed"
              : detail.progress_message ?? "Searching LinkedIn…"}
          </span>
        </div>
      )}

      {/* Results */}
      {isComplete && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500">
                  <CheckCircle2 size={16} className="text-white" />
                </div>
                <div>
                  <CardTitle className="text-base">
                    {results.length.toLocaleString()} {results.length === 1 ? "person" : "people"} found
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {selected.size > 0 ? `${selected.size} selected` : "Select people to import"}
                    {detail?.truncated && (
                      <span className="ml-1 text-amber-600">· more available — raise the cap</span>
                    )}
                  </p>
                </div>
              </div>
              {selected.size > 0 && (
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setSaveMsg(null);
                      setAddOpen((v) => !v);
                    }}
                    style={{ background: "#2E37FE" }}
                    className="text-white"
                  >
                    <Send size={15} className="mr-1.5" />
                    Add to campaign ({selected.size})
                  </Button>
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Add-to-campaign inline panel */}
            {addOpen && selected.size > 0 && (
              <div className="rounded-lg border border-[#2E37FE]/30 bg-[#EDEEFF]/40 p-4">
                <p className="text-sm font-medium text-[#1C24B8]">
                  Import {selected.size} to Contacts
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Pick a campaign to assign them to, or import without one. Enrichment runs in Contacts.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <select
                    value={targetCampaign}
                    onChange={(e) => setTargetCampaign(e.target.value)}
                    className="h-9 rounded-lg border border-input bg-background px-2 text-sm"
                  >
                    <option value="">No campaign (save only)</option>
                    {campaigns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    onClick={handleSave}
                    disabled={saving}
                    style={{ background: "#2E37FE" }}
                    className="text-white"
                  >
                    {saving ? <Loader2 size={15} className="mr-1.5 animate-spin" /> : null}
                    {targetCampaign ? "Import + add to campaign" : "Import to Contacts"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAddOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
            {saveMsg && (
              <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                <CheckCircle2 size={15} className="text-emerald-600" />
                {saveMsg}
              </div>
            )}

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={togglePage}
                        className="accent-[#2E37FE]"
                        aria-label="Select all on page"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden md:table-cell">Headline</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead className="hidden lg:table-cell">Location</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pageResults.map((r, i) => {
                    const url = r.linkedin_url ?? "";
                    const on = url && selected.has(url);
                    const name =
                      r.full_name ||
                      [r.first_name, r.last_name].filter(Boolean).join(" ") ||
                      "—";
                    return (
                      <TableRow key={url || i} data-state={on ? "selected" : undefined}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={Boolean(on)}
                            onChange={() => url && toggleRow(url)}
                            disabled={!url}
                            className="accent-[#2E37FE]"
                            aria-label={`Select ${name}`}
                          />
                        </TableCell>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell className="hidden max-w-[280px] truncate text-muted-foreground md:table-cell">
                          {r.headline ?? "—"}
                        </TableCell>
                        <TableCell>{r.company_name ?? "—"}</TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                          {r.location ?? "—"}
                        </TableCell>
                        <TableCell>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[#2E37FE] hover:opacity-70"
                              aria-label="Open LinkedIn profile"
                            >
                              <ExternalLink size={15} />
                            </a>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              currentPage={page}
              totalItems={results.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          </CardContent>
        </Card>
      )}

      {isComplete && results.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-4 py-6 text-sm text-muted-foreground">
          <AlertTriangle size={16} className="text-amber-500" />
          No matches. Loosen the filters or try different keywords.
        </div>
      )}
    </div>
  );
}
