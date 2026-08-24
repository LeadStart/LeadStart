"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { PipelineStatusPanel } from "./pipeline-status-panel";
import { fetchActiveEnrichmentRunId } from "@/components/contacts/enrichment-run-banner";

type Depth = "short" | "full" | "full_email";

// Per-profile sourcing rates. The actor bills $0.10 per search page (25
// profiles = $0.004/profile) for Short, + $0.004/profile to open each profile
// for Full, + ~$0.01/profile for the email lookup on Full+email. Confirmed
// against live runs ($0.28 for 18 and $0.33 for 25, both Full+email ≈ $0.014).
const DEPTHS: { value: Depth; label: string; hint: string; rate: number }[] = [
  { value: "short", label: "Short", hint: "cheapest · basic profile", rate: 0.004 },
  { value: "full", label: "Full", hint: "opens each profile", rate: 0.008 },
  { value: "full_email", label: "Full + email", hint: "adds an email search", rate: 0.014 },
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

// Every info affordance on this page opens one of these overlay modals —
// never an inline box that shifts the form.
type InfoKey = "tips" | "keywords" | "titles" | "locations" | "depth" | "estimate" | "segment";

// Click-to-fill Keywords patterns. searchQuery is one fuzzy query over the
// whole profile; these double as operator teaching examples (quotes, AND/OR/
// NOT + grouping — LinkedIn requires the operators in UPPERCASE).
// Every positive term here is a vertical / skill / phrase — never a job title
// (that's what the Job titles field is for). Role words appear only inside NOT()
// as exclusions, the one role-thing Keywords does that Job titles can't.
const KEYWORD_PATTERNS: { label: string; value: string }[] = [
  { label: "Cleaning vertical", value: '"commercial cleaning" OR janitorial' },
  { label: "Trades & field services", value: "HVAC OR plumbing OR electrical OR roofing" },
  { label: "Property niche", value: '"property management" OR "commercial real estate"' },
  { label: "Commercial, not residential", value: "cleaning AND (commercial OR industrial)" },
  { label: "Tools in the profile", value: "Salesforce OR HubSpot OR NetSuite" },
  { label: "Vertical, no recruiters", value: '"commercial cleaning" NOT (recruiter OR staffing)' },
];

// Job-title variant packs. currentJobTitles chips are OR'd, so a pack adds
// coverage (spelled-out + abbreviated forms) without narrowing anything.
const TITLE_PACKS: { label: string; titles: string[] }[] = [
  { label: "Founder / CEO", titles: ["Founder", "Co-Founder", "CEO", "Owner", "Managing Director"] },
  { label: "Sales leaders", titles: ["VP Sales", "Vice President of Sales", "Head of Sales", "Sales Director", "Chief Revenue Officer"] },
  { label: "Marketing leaders", titles: ["CMO", "VP Marketing", "Head of Marketing", "Marketing Director"] },
  { label: "Operations leaders", titles: ["COO", "VP Operations", "Head of Operations", "Operations Manager"] },
  { label: "Facilities", titles: ["Facilities Manager", "Facilities Director", "Director of Facilities", "Head of Facilities"] },
  { label: "Finance leaders", titles: ["CFO", "VP Finance", "Head of Finance", "Finance Director", "Controller"] },
  { label: "HR / People", titles: ["CHRO", "VP People", "Head of People", "HR Director"] },
  { label: "IT / Engineering", titles: ["CTO", "CIO", "VP Engineering", "Head of IT", "IT Director"] },
];

// Common Locations quick-adds (each value must be a full LinkedIn-resolvable name).
const LOCATION_QUICK_ADDS: { label: string; locations: string[] }[] = [
  { label: "United States", locations: ["United States"] },
  { label: "United Kingdom", locations: ["United Kingdom"] },
  { label: "Canada", locations: ["Canada"] },
  { label: "Australia", locations: ["Australia"] },
  { label: "Germany", locations: ["Germany"] },
  {
    label: "English-speaking (6)",
    locations: ["United States", "United Kingdom", "Canada", "Australia", "New Zealand", "Ireland"],
  },
];

// Known location-input traps. The actor resolves free text via LinkedIn's
// autocomplete and silently pins the TOP hit — these are inputs where that
// hit is wrong (abbreviations) or a coin flip (shared names). `fix` = safe
// replacement offered as a one-click swap; otherwise the hint says how to
// qualify. Keys are matched on the trimmed, lowercased chip value.
const LOCATION_TRAPS: Record<string, { fix?: string; hint: string }> = {
  uk: { fix: "United Kingdom", hint: "resolves to Ukraine on LinkedIn" },
  "u.k.": { fix: "United Kingdom", hint: "resolves to Ukraine on LinkedIn" },
  us: { fix: "United States", hint: "abbreviations resolve unreliably — use the full name" },
  "u.s.": { fix: "United States", hint: "abbreviations resolve unreliably — use the full name" },
  usa: { fix: "United States", hint: "abbreviations resolve unreliably — use the full name" },
  "u.s.a.": { fix: "United States", hint: "abbreviations resolve unreliably — use the full name" },
  america: { fix: "United States", hint: "abbreviations resolve unreliably — use the full name" },
  uae: { fix: "United Arab Emirates", hint: "abbreviations resolve unreliably — use the full name" },
  georgia: { hint: "the country and the US state collide — use “Georgia, United States” for the state" },
  washington: { hint: "the state and the capital collide — use “Washington, D.C.” or “Washington State”" },
  cambridge: { hint: "UK and Massachusetts collide — use “Cambridge, Massachusetts” or “Cambridge, United Kingdom”" },
  birmingham: { hint: "UK and Alabama collide — use “Birmingham, Alabama” or “Birmingham, United Kingdom”" },
  portland: { hint: "Oregon and Maine collide — use “Portland, Oregon” or “Portland, Maine”" },
};

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

// The one popup pattern for info content on this page: an overlay Dialog that
// never shifts the form layout.
function InfoDialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className={`${wide ? "max-w-2xl" : "max-w-lg"} w-[95vw] max-h-[85vh] overflow-y-auto overflow-x-hidden`}
      >
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words">{title}</DialogTitle>
        </DialogHeader>
        {/* min-w-0 lets this grid item shrink so its content wraps instead of
            forcing the modal to scroll horizontally. */}
        <div className="min-w-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

function InfoButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-haspopup="dialog"
      className="cursor-pointer text-muted-foreground transition-colors hover:text-[#2E37FE]"
    >
      <Info size={13} />
    </button>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-px font-mono text-[11px] break-words text-foreground">
      {children}
    </code>
  );
}

// A clickable preset row inside an info modal: name on top, the value it fills
// below — stacked (not side-by-side) so long values wrap in place instead of
// truncating or forcing the modal to scroll sideways.
function PresetRow({ label, value, onClick }: { label: string; value: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border border-border px-2.5 py-1.5 text-left transition-colors hover:border-[#2E37FE]/50 hover:bg-[#EDEEFF]/40"
    >
      <span className="text-[11px] font-semibold text-foreground">{label}</span>
      <span className="break-words font-mono text-[11px] text-[#1C24B8]">{value}</span>
    </button>
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
  // Deep search: fan the query into per-state/seniority sub-queries so we pull
  // past LinkedIn's ~25-per-query cookieless cap. On by default — a single query
  // rarely returns more than one page.
  const [autoSegment, setAutoSegment] = useState(true);
  const [depth, setDepth] = useState<Depth>("short");
  const [maxResults, setMaxResults] = useState<number>(250);
  // Advanced
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Which info modal is open (only ever one at a time).
  const [infoOpen, setInfoOpen] = useState<InfoKey | null>(null);
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

  // The org's active enrichment run — drives the enrichment stages of the live
  // status panel. Set on import; resumed on mount so a refresh mid-run recovers.
  const [enrichmentRunId, setEnrichmentRunId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchActiveEnrichmentRunId().then((id) => {
      if (!cancelled && id) setEnrichmentRunId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
    if (autoSegment) levers.autoSegment = true;
    return levers;
  };

  const applyPreset = (p: Preset) => {
    setJobTitles(p.titles ?? []);
    setSeniority(new Set(p.seniority ?? []));
    setFunctions(new Set(p.functions ?? []));
    setIndustries(new Set(p.industries ?? []));
    setInfoOpen(null);
  };

  // Location chips that hit a known resolution trap (see LOCATION_TRAPS).
  const locationFlags = useMemo(
    () =>
      locations.flatMap((v) => {
        const trap = LOCATION_TRAPS[v.trim().toLowerCase()];
        return trap ? [{ value: v, ...trap }] : [];
      }),
    [locations],
  );

  const replaceLocation = (from: string, to: string) =>
    setLocations((prev) => Array.from(new Set(prev.map((v) => (v === from ? to : v)))));

  const addLocations = (values: string[]) =>
    setLocations((prev) => Array.from(new Set([...prev, ...values])));

  const addTitles = (values: string[]) =>
    setJobTitles((prev) => Array.from(new Set([...prev, ...values])));

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

  const pageResults = useMemo(
    () => results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [results, page],
  );
  // Full / Full+email searches attach emails to rows; Short doesn't. Only show
  // the Email column when the run actually carries some (avoids a dead column).
  const emailCount = useMemo(() => results.filter((r) => Boolean(r.email)).length, [results]);
  const hasEmails = emailCount > 0;
  // Actual $ the actor run cost (usageTotalUsd), written by the worker on finish.
  const actualCost = detail ? Number(detail.cost_usd) || 0 : 0;
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
      // Light up the enrichment stages of the live panel: a fresh run to poll,
      // or the org's already-active run if this batch queued behind one.
      const enr = data.enrichment as
        | { status: "started"; runId: string }
        | { status: "queued" }
        | { status: "skipped" }
        | undefined;
      if (enr?.status === "started") {
        setEnrichmentRunId(enr.runId);
      } else if (enr?.status === "queued") {
        const id = await fetchActiveEnrichmentRunId();
        if (id) setEnrichmentRunId(id);
      }
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
      {/* Form (left) + live enrichment status (right) */}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
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
            onClick={() => setInfoOpen("tips")}
            aria-haspopup="dialog"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-[#2E37FE] hover:bg-[#EDEEFF]/50"
          >
            <HelpCircle size={14} />
            How to search
          </button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>Keywords</Label>
                <InfoButton label="About Keywords" onClick={() => setInfoOpen("keywords")} />
              </div>
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder='e.g. "commercial cleaning" OR janitorial'
                style={{ height: 38 }}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>Job titles</Label>
                <InfoButton label="About Job titles" onClick={() => setInfoOpen("titles")} />
              </div>
              <ChipInput
                placeholder="Type a title, press Enter"
                values={jobTitles}
                onChange={setJobTitles}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Label>Locations</Label>
                <InfoButton label="About Locations" onClick={() => setInfoOpen("locations")} />
              </div>
              <ChipInput
                placeholder="e.g. United States, California, Chicago"
                values={locations}
                onChange={setLocations}
              />
              <p className="text-[11px] text-muted-foreground">
                Country, state/region, or city — LinkedIn has no zip or county. Use full names (&ldquo;United Kingdom&rdquo;, not &ldquo;UK&rdquo;).
              </p>
              {locationFlags.length > 0 && (
                <div className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
                  {locationFlags.map((f) => {
                    const fix = f.fix;
                    return (
                      <div
                        key={f.value}
                        className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-amber-800"
                      >
                        <AlertTriangle size={12} className="shrink-0 text-amber-500" />
                        <span>
                          <span className="font-medium">&ldquo;{f.value}&rdquo;</span> — {f.hint}
                        </span>
                        {fix && (
                          <button
                            type="button"
                            onClick={() => replaceLocation(f.value, fix)}
                            className="cursor-pointer rounded border border-amber-300 bg-white px-1.5 py-0.5 font-medium text-amber-900 hover:bg-amber-100"
                          >
                            Use &ldquo;{fix}&rdquo;
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
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

          {/* Deep search (query segmentation) */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-[#2E37FE]/20 bg-[#EDEEFF]/30 px-3 py-2">
            <button
              type="button"
              role="switch"
              aria-checked={autoSegment}
              onClick={() => setAutoSegment((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-2"
            >
              <span
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
                  autoSegment ? "bg-[#2E37FE]" : "bg-slate-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all ${
                    autoSegment ? "left-[18px]" : "left-0.5"
                  }`}
                />
              </span>
              <span className="text-sm font-medium">Deep search</span>
            </button>
            <span className="text-[12px] text-muted-foreground">
              Sweeps by state &amp; seniority to pull past LinkedIn&apos;s ~25-per-query cap.
            </span>
            <InfoButton label="About Deep search" onClick={() => setInfoOpen("segment")} />
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
                  <InfoButton label="What does depth mean?" onClick={() => setInfoOpen("depth")} />
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
                <InfoButton label="How is this estimated?" onClick={() => setInfoOpen("estimate")} />
              </div>
            </div>
          </div>

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

      <PipelineStatusPanel
        search={detail}
        starting={starting}
        enrichmentRunId={enrichmentRunId}
      />
      </div>

      {/* Info modals — the single popup pattern for every (i) on this page */}
      <InfoDialog open={infoOpen === "tips"} onClose={() => setInfoOpen(null)} title="How to search" wide>
        <div className="space-y-3 text-[12px] text-slate-600">
          <div className="space-y-1.5 rounded-lg border border-[#2E37FE]/20 bg-[#EDEEFF]/40 p-3">
            <p className="text-[13px] font-medium text-slate-900">How your filters combine</p>
            <p>
              <span className="font-medium text-slate-800">Within a field</span>, multiple values are
              OR&apos;d — match <span className="font-medium">any</span>. <span className="font-medium text-slate-800">Across fields</span> — Keywords,
              Job titles, Locations, Seniority, every one — it&apos;s <span className="font-medium">AND</span>: each field you
              fill removes anyone who doesn&apos;t match it, so more fields means fewer, tighter
              results, never more.
            </p>
            <p>
              <span className="font-medium text-slate-800">Example:</span> Job titles{" "}
              <span className="font-mono">VP Sales, Head of Sales</span> + Keywords{" "}
              <span className="font-mono">fintech</span> returns only those title-holders whose profile
              also says fintech — a fintech CMO drops out (wrong title), and a VP Sales who never wrote
              &ldquo;fintech&rdquo; drops out (no keyword).
            </p>
            <p>
              <span className="font-medium text-slate-800">Common trap:</span> don&apos;t put a title in
              Keywords too. Keywords <span className="font-mono">&ldquo;VP of Sales&rdquo;</span> +
              Job titles <span className="font-mono">VP Sales</span> double-constrains and can quietly
              shrink results. The role → Job titles; everything else → Keywords.
            </p>
          </div>
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-medium text-slate-800">Multiple values:</span> in Job titles and Locations, type a value and press Enter (or comma) to add several — results match <span className="font-medium">any</span> of them. e.g. VP Sales, Head of Sales, CRO.
            </li>
            <li>
              <span className="font-medium text-slate-800">Seniority · Function · Industry</span> are multi-select (Industry is searchable) — pick as many as apply.
            </li>
            <li>
              <span className="font-medium text-slate-800">Keywords</span> reads the whole profile, not just the title — and it&apos;s the only field with operators: an &ldquo;exact phrase&rdquo; in quotes, plus AND / OR / NOT — e.g. &ldquo;commercial cleaning&rdquo; OR janitorial NOT recruiter. (Roles go in Job titles, not here.)
            </li>
            <li>
              <span className="font-medium text-slate-800">For precise, non-wildcard targeting,</span> lean on the facets (they map to LinkedIn&apos;s own codes) over Keywords. Company size and the timing toggles narrow further.
            </li>
            <li>
              <span className="font-medium text-slate-800">Field-level help:</span> the <Info size={11} className="inline text-slate-500" /> next to Keywords, Job titles, and Locations opens per-field tips with click-to-fill patterns.
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
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "keywords"}
        onClose={() => setInfoOpen(null)}
        title="Keywords — fuzzy whole-profile search"
      >
        <div className="space-y-3 text-[12px] text-muted-foreground">
          <p>
            One free-text query matched{" "}
            <span className="font-medium text-foreground">fuzzily across the whole profile</span> —
            headline, about, experience, skills. It reaches wider than any other field (a single
            keyword alone returns more people than the same word as a title) and it&apos;s the{" "}
            <span className="font-medium text-foreground">only field that understands operators</span>.
          </p>
          <p>
            But it doesn&apos;t stack on top of Job titles — it{" "}
            <span className="font-medium text-foreground">AND&apos;s</span> with them. Keywords + Job
            titles returns only the <span className="font-medium text-foreground">overlap</span>
            (people who match both), not the sum. Use it to catch profile signals a title can&apos;t
            express, not to re-state the title.
          </p>
          <div>
            <p className="font-medium text-foreground">LinkedIn operators — UPPERCASE only</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                <Code>&quot;exact phrase&quot;</Code> — quotes lock a phrase:{" "}
                <Code>&quot;property management&quot;</Code>
              </li>
              <li>
                <Code>AND</Code> · <Code>OR</Code> · <Code>NOT</Code>, grouped with parentheses:{" "}
                <Code>cleaning AND (commercial OR industrial)</Code>
              </li>
              <li>Lowercase and / or / not are treated as ordinary words, not operators.</li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">Tips</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                It&apos;s one query, not a list — join alternatives with <Code>OR</Code>, not commas.
              </li>
              <li>
                Keywords is for niche / industry / tech words (&ldquo;HVAC&rdquo;, &ldquo;med
                spa&rdquo;, &ldquo;Salesforce&rdquo;). Who the person <em>is</em> belongs in Job
                titles.
              </li>
              <li>
                Whole-profile matching is noisy — pair it with the Seniority / Function facets, and
                add <Code>NOT recruiter</Code>: recruiters&apos; profiles mention every title they
                hire for.
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 font-medium text-foreground">Patterns — click to fill</p>
            <div className="space-y-1">
              {KEYWORD_PATTERNS.map((p) => (
                <PresetRow
                  key={p.label}
                  label={p.label}
                  value={p.value}
                  onClick={() => {
                    setQuery(p.value);
                    setInfoOpen(null);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "titles"}
        onClose={() => setInfoOpen(null)}
        title="Job titles — current title, any match"
      >
        <div className="space-y-3 text-[12px] text-muted-foreground">
          <p>
            A structured filter on the person&apos;s{" "}
            <span className="font-medium text-foreground">current title only</span> — past roles
            don&apos;t count, and it looks at the title, not the rest of the profile (that&apos;s
            Keywords&apos; job). Each chip is OR&apos;d: a person matches if their title matches{" "}
            <span className="font-medium text-foreground">any</span> chip, so extra chips widen this
            field without touching your other filters.
          </p>
          <div>
            <p className="font-medium text-foreground">What to expect</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Abbreviations aren&apos;t reliably expanded — add both &ldquo;VP Sales&rdquo; and
                &ldquo;Vice President of Sales&rdquo; when it matters. The variant packs below do this
                for you.
              </li>
              <li>
                It targets the title precisely, so it won&apos;t fuzzy-match a role from someone&apos;s
                About or skills — reach for Keywords when you want the whole profile read.
              </li>
              <li>
                Plain titles only: quotes and AND / OR / NOT do nothing here — operators live in
                Keywords.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">Tips</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Near-misses slipping through (&ldquo;Assistant to the CEO&rdquo;)? Advanced →
                Exclude job titles: Assistant, Intern, Former.
              </li>
              <li>
                Titles are free text people invent — the Seniority facet is the precise way to
                enforce level. Use both together.
              </li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 font-medium text-foreground">Variant packs — click to add</p>
            <div className="space-y-1">
              {TITLE_PACKS.map((p) => (
                <PresetRow
                  key={p.label}
                  label={p.label}
                  value={p.titles.join(" · ")}
                  onClick={() => {
                    addTitles(p.titles);
                    setInfoOpen(null);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "locations"}
        onClose={() => setInfoOpen(null)}
        title="Locations — resolved by LinkedIn autocomplete"
      >
        <div className="space-y-3 text-[12px] text-muted-foreground">
          <p>
            Each value runs through LinkedIn&apos;s location autocomplete and is pinned to the{" "}
            <span className="font-medium text-foreground">top hit — silently</span>. People in{" "}
            <span className="font-medium text-foreground">any</span> listed location match.
          </p>
          <div>
            <p className="font-medium text-foreground">Granularity</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Country, state/region, or city — nothing finer. No zip codes, no counties, no
                mile radius.
              </li>
              <li>
                A city may resolve to LinkedIn&apos;s wider metro area (&ldquo;Greater Chicago
                Area&rdquo;) — that&apos;s normal and usually helpful.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">Avoiding wrong resolutions</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                Full names, never abbreviations:{" "}
                <span className="font-medium text-foreground">
                  &ldquo;UK&rdquo; resolves to Ukraine
                </span>{" "}
                — write &ldquo;United Kingdom&rdquo;. Same idea for &ldquo;United States&rdquo; and
                &ldquo;United Arab Emirates&rdquo;.
              </li>
              <li>
                Qualify ambiguous names with a state or country: &ldquo;Portland, Oregon&rdquo; ·
                &ldquo;Cambridge, Massachusetts&rdquo; · &ldquo;Georgia, United States&rdquo;.
              </li>
              <li>The field flags known traps as you add them, with a one-click fix.</li>
            </ul>
          </div>
          <div>
            <p className="mb-1.5 font-medium text-foreground">Quick-adds</p>
            <div className="space-y-1">
              {LOCATION_QUICK_ADDS.map((p) => (
                <PresetRow
                  key={p.label}
                  label={p.label}
                  value={p.locations.join(" · ")}
                  onClick={() => {
                    addLocations(p.locations);
                    setInfoOpen(null);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "segment"}
        onClose={() => setInfoOpen(null)}
        title="Deep search — query segmentation"
        wide
      >
        <div className="space-y-3 text-[12px] text-muted-foreground">
          <p>
            LinkedIn&apos;s cookieless (logged-out) search only returns about{" "}
            <span className="font-medium text-foreground">one page — ~25 people — per query</span>,
            no matter how many you ask for. Deep search gets around that by{" "}
            <span className="font-medium text-foreground">
              splitting your search into many narrower sub-queries
            </span>{" "}
            — by US state, then seniority band — and sweeping across them until it reaches your{" "}
            <span className="font-medium text-foreground">Max people</span> target. Same filters,
            just run as dozens of slices instead of one capped query.
          </p>
          <div>
            <p className="font-medium text-foreground">What it changes</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                <span className="font-medium">More results</span> — a query that returns 25 flat can
                return hundreds once it&apos;s swept state-by-state.
              </li>
              <li>
                <span className="font-medium">Costs more</span> — you&apos;re billed per search page,
                and this scrapes a page (or more) per slice. Cost scales with how many people you
                actually pull, so it roughly tracks your Max people.
              </li>
              <li>
                <span className="font-medium">Duplicates are removed</span> across slices, so you
                won&apos;t import the same person twice.
              </li>
            </ul>
          </div>
          <div>
            <p className="font-medium text-foreground">When to turn it off</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                A genuinely tiny niche where ~25 is plenty — a single query is cheaper, and sweeping
                empty state slices just adds cost.
              </li>
              <li>A quick sanity check before committing to a full pull.</li>
            </ul>
          </div>
          <p className="rounded-md bg-[#EDEEFF]/70 px-2.5 py-2 text-[11px]">
            Rule of thumb: leave it <span className="font-medium text-foreground">on</span> when you
            want real volume, off for a cheap peek. Raising <span className="font-medium">Max people</span>{" "}
            is what tells it how far to sweep.
          </p>
        </div>
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "depth"}
        onClose={() => setInfoOpen(null)}
        title="What &ldquo;Depth&rdquo; controls"
      >
        <div className="space-y-2 text-[12px] text-muted-foreground">
          <p>How deep the actor reads each result:</p>
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
      </InfoDialog>

      <InfoDialog
        open={infoOpen === "estimate"}
        onClose={() => setInfoOpen(null)}
        title="Cost by stage &amp; actor"
      >
        <div className="space-y-2.5 text-[12px] text-muted-foreground">
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
            A ceiling, not a bill: sourcing charges only for profiles the actor can return; enrichment bills only on people you actually import (usually a subset), and each waterfall pass only touches people the previous one left without an email. Verification runs once, at first send. With Deep search on, sourcing sweeps sub-queries to actually reach your Max people, so the sourcing figure is realistic rather than a rarely-hit ceiling.
          </p>

          <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px]">
            <p className="font-medium text-foreground">Plus your Apify plan&apos;s monthly minimum</p>
            <p className="mt-0.5">
              These are usage charges that draw against your Apify plan&apos;s prepaid balance
              (Starter = <span className="font-mono">$29</span>/mo). That minimum is a floor, not
              additive per run — but it <span className="font-medium text-foreground">doesn&apos;t roll over</span>, so a
              light month still bills $29. Residential proxy and compute are already bundled into the
              per-result prices above — no separate proxy or compute-unit line.
            </p>
          </div>
        </div>
      </InfoDialog>

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
                    {hasEmails && (
                      <span className="ml-1 text-emerald-600">· {emailCount} with email</span>
                    )}
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
                    {hasEmails && <TableHead>Email</TableHead>}
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
                        {hasEmails && (
                          <TableCell className="font-mono text-[12px]">
                            {r.email ? (
                              <span className="text-foreground">{r.email}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
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
            <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
              <span>Actual Apify cost for this search — billed per profile returned, not per target</span>
              <span className="font-mono tabular-nums font-medium text-foreground">
                ${actualCost.toFixed(2)}
              </span>
            </div>
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
