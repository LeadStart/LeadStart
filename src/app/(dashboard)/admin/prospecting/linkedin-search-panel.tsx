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
  ChevronRight,
  Send,
  ExternalLink,
  Info,
  HelpCircle,
  Bookmark,
  Trash2,
  History,
  Globe,
  Activity,
  Mail,
  Clock,
  XCircle,
  Pencil,
  Check,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { LivePricing } from "@/lib/apify/live-pricing";
import { createClient } from "@/lib/supabase/client";
import type {
  LinkedInProspect,
  LinkedInSearchStatus,
  EnrichmentRunItem,
  EnrichmentAddons,
} from "@/types/app";
import {
  HEADCOUNTS,
  SENIORITY_LEVELS,
  FUNCTIONS,
  INDUSTRIES,
} from "@/lib/apify/sourcing/linkedin-facets";
import { PipelineStatusPanel } from "./pipeline-status-panel";
import { fetchActiveEnrichmentRunId } from "@/components/contacts/enrichment-run-banner";

type Depth = "short" | "full" | "full_email";

// The full form state a saved preset captures + restores.
type SearchConfig = {
  query: string;
  jobTitles: string[];
  locations: string[];
  headcount: string[];
  seniority: string[];
  functions: string[];
  industries: string[];
  excludeTitles: string[];
  currentCompanies: string[];
  recentlyChanged: boolean;
  activePosters: boolean;
  autoSegment: boolean;
  addActivity: boolean;
  addVerify: boolean;
  depth: Depth;
  maxResults: number;
};

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
// Actors: profile-scraper (email), linkedin-company (domain), pattern + verify
// (2nd pass — the default method), profile-posts (activity); verify is Million
// Verifier (not Apify).
const ENRICH_RATES = {
  email: 0.01,
  domain: 0.004,
  waterfall: 0.004,
  activity: 0.005,
  verify: 0.0006,
  // Web lookup for companies with no LinkedIn page. Only that subset incurs it,
  // but it's counted per-person in the ceiling estimate (see the breakdown note).
  domain_discovery: 0.005,
};

// Deep search (auto query-segmentation) sweeps many sub-queries and opens far
// more profiles than it returns after de-duplication, so it bills well above
// rate × target — a single-query search does not. Observed ≈3.5× on a Full+email
// run (target 25 → $1.25 actual vs a $0.35 base estimate). Applied as a
// multiplier so the estimate is a realistic ceiling instead of a 3–4× undercount.
// Approximate (overlap varies with how broad the ICP is) — refine as more runs land.
const DEEP_SEARCH_MULTIPLIER = 3.5;

const MAX_OPTIONS = [100, 250, 500, 1000] as const;
const POLL_MS = 3000;
const PAGE_SIZE = 50;

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
type InfoKey = "tips" | "keywords" | "titles" | "locations" | "depth" | "estimate" | "segment" | "actual";

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
  // `query.name` is the user's custom label (falls back to the ICP summary).
  query: {
    name?: string;
    levers?: Record<string, unknown>;
    depth?: string;
    addons?: { activity?: boolean; verify?: boolean };
  } | null;
  results: LinkedInProspect[];
  result_count: number;
  target_max_results: number;
  truncated: boolean;
  status: LinkedInSearchStatus;
  progress_message: string | null;
  error_message: string | null;
  cost_usd: number | string;
};

// One row of the collapsible "Prior runs" list (the [id] `results` JSONB is
// stripped by the list endpoint — clicking a run loads it via the poll).
type PriorRun = {
  id: string;
  query: { name?: string; levers?: Record<string, unknown>; depth?: string } | null;
  result_count: number;
  target_max_results: number;
  saved_count: number | null;
  status: LinkedInSearchStatus;
  cost_usd: number | string;
  completed_at: string | null;
  created_at: string;
};

// The slice of an enrichment run item the results table layers onto a sourced
// row (Phase 2). Keyed by lower(linkedin_url) to match a LinkedInProspect.
type EnrichLite = Pick<
  EnrichmentRunItem,
  | "linkedin_url"
  | "email"
  | "company_domain"
  | "last_posted_at"
  | "profile_status"
  | "domain_status"
  | "waterfall_status"
  | "activity_status"
> & {
  // Joined from contacts.company_email by the run-detail route (migration 00076).
  company_email?: string | null;
};

type Campaign = { id: string; name: string };

const LC = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

// A one-line ICP summary for a prior run, built from its stored levers.
function describeLevers(query: PriorRun["query"]): string {
  const lv = query?.levers ?? {};
  const parts: string[] = [];
  const titles = lv.currentJobTitles as string[] | undefined;
  const q = lv.query as string | undefined;
  const locs = lv.locations as string[] | undefined;
  if (titles?.length) parts.push(titles.slice(0, 2).join(", ") + (titles.length > 2 ? ` +${titles.length - 2}` : ""));
  else if (q) parts.push(`"${q.length > 40 ? q.slice(0, 40) + "…" : q}"`);
  if (locs?.length) parts.push("in " + locs.slice(0, 2).join(", ") + (locs.length > 2 ? ` +${locs.length - 2}` : ""));
  const sen = lv.seniorityLevelIds as string[] | undefined;
  const ind = lv.industryIds as string[] | undefined;
  if (!parts.length && sen?.length) parts.push(`${sen.length} seniority`);
  if (!parts.length && ind?.length) parts.push(`${ind.length} industry`);
  return parts.join(" ") || "All people";
}

// The label to show for a search: the user's custom name, else the auto ICP
// summary derived from its levers.
function searchName(
  query: { name?: string; levers?: Record<string, unknown>; depth?: string } | null | undefined,
): string {
  const n = query?.name?.trim();
  return n || describeLevers(query ?? null);
}

function timeAgoShort(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Loosened step-status type: the EnrichLite fields are EnrichmentStepStatus,
// but waterfall/activity can be null, and helpers accept undefined for absence.
type EnrichmentStepish =
  | "pending"
  | "in_flight"
  | "found"
  | "not_found"
  | "skipped"
  | "error"
  | null
  | undefined;

function ChipInput({
  placeholder,
  values,
  onChange,
  // Multi-value fields all add on Enter/comma — say so. Override for a field-
  // specific note; pass null to hide entirely.
  hint = "Press Enter or comma to add several — each is searched as its own term.",
}: {
  placeholder: string;
  values: string[];
  onChange: (v: string[]) => void;
  hint?: string | null;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="space-y-1">
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
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
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

// Saved-search dropdown: name + store the whole form as a preset (org-shared,
// so it follows you across machines and teammates), then reload or delete it.
function SavedSearches({
  getConfig,
  onLoad,
}: {
  getConfig: () => SearchConfig;
  onLoad: (config: SearchConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<{ id: string; name: string; config: SearchConfig }[]>([]);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Inline rename of an existing preset.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/search-presets"), { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setPresets((data.presets ?? []) as { id: string; name: string; config: SearchConfig }[]);
    } catch {
      // ignore — leave list as-is
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const save = async () => {
    const n = name.trim();
    if (!n) return;
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/search-presets"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n, config: getConfig() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data.error ?? "Save failed");
        setSaving(false);
        return;
      }
      setName("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    }
    setSaving(false);
  };

  const remove = async (id: string) => {
    setPresets((p) => p.filter((x) => x.id !== id)); // optimistic
    try {
      await fetch(appUrl(`/api/admin/prospecting/search-presets/${id}`), { method: "DELETE" });
    } catch {
      load();
    }
  };

  const startEdit = (p: { id: string; name: string }) => {
    setErr(null);
    setEditingId(p.id);
    setEditDraft(p.name);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft("");
  };
  const saveEdit = async (id: string) => {
    const n = editDraft.trim();
    if (!n) return;
    const prev = presets;
    // Optimistic rename; revert on failure.
    setPresets((list) => list.map((x) => (x.id === id ? { ...x, name: n } : x)));
    cancelEdit();
    try {
      const res = await fetch(appUrl(`/api/admin/prospecting/search-presets/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setPresets(prev);
        setErr(data.error ?? "Rename failed");
      }
    } catch {
      setPresets(prev);
      load();
    }
  };

  // Drop any in-progress rename when the dropdown closes.
  useEffect(() => {
    if (!open) {
      setEditingId(null);
      setEditDraft("");
    }
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-[#2E37FE] hover:bg-[#EDEEFF]/50"
      >
        <Bookmark size={14} fill={presets.length > 0 ? "currentColor" : "none"} />
        Saved{presets.length ? ` (${presets.length})` : ""}
        <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute right-0 top-[40px] z-40 w-72 rounded-lg border border-border bg-background p-2 shadow-lg">
          <div className="mb-2">
            <p className="mb-1 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Save current search
            </p>
            <div className="flex gap-1.5">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    save();
                  }
                }}
                placeholder="Name this search"
                className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[#2E37FE]"
              />
              <Button
                size="sm"
                onClick={save}
                disabled={saving || !name.trim()}
                style={{ background: "#2E37FE" }}
                className="text-white"
              >
                {saving ? <Loader2 size={13} className="animate-spin" /> : "Save"}
              </Button>
            </div>
            {err && <p className="mt-1 text-[11px] text-red-600">{err}</p>}
          </div>
          <div className="border-t border-border pt-1.5">
            {loading ? (
              <p className="px-1 py-2 text-[12px] text-muted-foreground">Loading…</p>
            ) : presets.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-muted-foreground">
                No saved searches yet — name one above.
              </p>
            ) : (
              <div className="max-h-56 overflow-auto">
                {presets.map((p) =>
                  editingId === p.id ? (
                    <div key={p.id} className="flex items-center gap-1 rounded-md px-1">
                      <input
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            saveEdit(p.id);
                          }
                          if (e.key === "Escape") {
                            e.preventDefault();
                            cancelEdit();
                          }
                        }}
                        maxLength={80}
                        className="min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[#2E37FE]"
                      />
                      <button
                        type="button"
                        onClick={() => saveEdit(p.id)}
                        disabled={!editDraft.trim()}
                        aria-label={`Save name for ${p.name}`}
                        className="shrink-0 rounded p-1 text-muted-foreground hover:text-emerald-600 disabled:opacity-40"
                      >
                        <Check size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        aria-label="Cancel rename"
                        className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ) : (
                    <div key={p.id} className="group flex items-center gap-1 rounded-md px-1 hover:bg-muted">
                      <button
                        type="button"
                        onClick={() => {
                          onLoad(p.config);
                          setOpen(false);
                        }}
                        className="min-w-0 flex-1 truncate py-1.5 text-left text-[12.5px]"
                        title={p.name}
                      >
                        {p.name}
                      </button>
                      <button
                        type="button"
                        onClick={() => startEdit(p)}
                        aria-label={`Rename ${p.name}`}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-[#2E37FE] group-hover:opacity-100"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(p.id)}
                        aria-label={`Delete ${p.name}`}
                        className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function LinkedInSearchPanel() {
  // Optional name for this run — labels it in Prior runs + above the results
  // (renamable later). Stored on the search's query.name at creation.
  const [searchNameInput, setSearchNameInput] = useState("");
  // Levers
  const [query, setQuery] = useState("");
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [locations, setLocations] = useState<string[]>(["United States"]);
  const [headcount, setHeadcount] = useState<Set<string>>(new Set());
  const [recentlyChanged, setRecentlyChanged] = useState(false);
  const [activePosters, setActivePosters] = useState(false);
  // Opt-in enrichment add-ons (default OFF) chosen for this search. Activity =
  // score posting recency; verify = Million Verifier every found email.
  const [addActivity, setAddActivity] = useState(false);
  const [addVerify, setAddVerify] = useState(false);
  // Org kill-switch: does a finished search auto-import + enrich? Only changes
  // the panel's "sourced" caption. Fetched once from enrichment settings.
  const [autoRun, setAutoRun] = useState(true);
  // Org setting: discover websites for companies with no LinkedIn page (feeds the
  // per-person estimate + the breakdown row).
  const [domainDiscoveryOn, setDomainDiscoveryOn] = useState(true);
  // Deep search (auto query-segmentation): a PAID-Apify feature that splits a
  // search into sub-queries to pull past LinkedIn's 2,500-per-query ceiling.
  // OFF by default — it's only for bulk pulls, and on the free Apify tier the
  // actor refuses to segment and returns zero.
  const [autoSegment, setAutoSegment] = useState(false);
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

  // Phase 2 per-row overlay: enrichment run items keyed by lower(linkedin_url).
  // Polls the same run the status panel radial reads, but pulls the item rows
  // so each sourced row's email/domain/activity fills in live as it's found.
  const [enrichByUrl, setEnrichByUrl] = useState<Map<string, EnrichLite>>(new Map());
  // URLs the user imported this session — lets a row show "Queued" the instant
  // it's sent, before the run's item rows exist to poll.
  const [importedUrls, setImportedUrls] = useState<Set<string>>(new Set());
  // Actual enrichment-run spend (Apify usageTotalUsd accumulated by the worker),
  // for the cost-breakdown popover on the results footer.
  const [enrichRunCost, setEnrichRunCost] = useState(0);
  const enrichTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Live Apify pricing (pulled fresh, cached ~1h server-side) so the estimate
  // never goes stale. Falls back to the static pricing constants below on error.
  const [livePricing, setLivePricing] = useState<LivePricing | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(appUrl("/api/admin/enrichment/pricing"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d) setLivePricing(d as LivePricing);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // The org's auto-run-after-search kill-switch (from enrichment settings).
  useEffect(() => {
    let cancelled = false;
    fetch(appUrl("/api/admin/enrichment/settings"), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.settings) {
          setAutoRun(d.settings.auto_run_after_search !== false);
          setDomainDiscoveryOn(d.settings.domain_discovery_enabled !== false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  // When a search has completed but we don't yet have its enrichment run id (the
  // cron auto-imports server-side, or a manual import queued behind another run),
  // poll for the org's active run so the panel lights up without a page refresh.
  useEffect(() => {
    if (!(detail?.status === "complete") || enrichmentRunId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const id = await fetchActiveEnrichmentRunId();
      if (cancelled) return;
      if (id) {
        setEnrichmentRunId(id);
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [detail?.status, enrichmentRunId]);
  useEffect(() => {
    if (!enrichmentRunId) return;
    let cancelled = false;
    const stop = () => {
      if (enrichTimer.current) {
        clearTimeout(enrichTimer.current);
        enrichTimer.current = null;
      }
    };
    const poll = async () => {
      try {
        const res = await fetch(appUrl(`/api/admin/contacts/enrich/run/${enrichmentRunId}`), {
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as {
            run: { status: string; cost_usd?: number | string };
            items: EnrichLite[];
          };
          if (cancelled) return;
          const map = new Map<string, EnrichLite>();
          for (const it of data.items ?? []) {
            const k = LC(it.linkedin_url);
            if (k) map.set(k, it);
          }
          setEnrichByUrl(map);
          setEnrichRunCost(Number(data.run.cost_usd) || 0);
          if (data.run.status === "complete" || data.run.status === "failed") return; // terminal — stop
        }
      } catch {
        // transient — reschedule
      }
      if (!cancelled) enrichTimer.current = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      cancelled = true;
      stop();
    };
  }, [enrichmentRunId]);

  // Collapsible "Prior runs" list.
  const [priorRuns, setPriorRuns] = useState<PriorRun[]>([]);
  const [priorOpen, setPriorOpen] = useState(false);
  const loadPriorRuns = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/linkedin-searches"), {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json();
      setPriorRuns(Array.isArray(data.searches) ? (data.searches as PriorRun[]) : []);
    } catch {
      // ignore — leave list as-is
    }
  }, []);
  useEffect(() => {
    loadPriorRuns();
  }, [loadPriorRuns]);

  // Collapse the active results card, and name / rename any search. The name
  // lives on the search's `query.name` (PATCH /linkedin-searches/[id]); an
  // empty name clears it back to the auto ICP summary.
  const [resultsCollapsed, setResultsCollapsed] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const startRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameDraft(current);
  };
  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };
  const saveRename = useCallback(
    async (id: string) => {
      const name = renameDraft.trim().slice(0, 80);
      // Optimistic: patch local state first so the label updates instantly.
      setPriorRuns((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, query: { ...(r.query ?? {}), name: name || undefined } } : r,
        ),
      );
      setDetail((d) =>
        d && d.id === id ? { ...d, query: { ...(d.query ?? {}), name: name || undefined } } : d,
      );
      setRenamingId(null);
      setRenameDraft("");
      try {
        await fetch(appUrl(`/api/admin/prospecting/linkedin-searches/${id}`), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
      } catch {
        loadPriorRuns(); // reconcile on failure
      }
    },
    [renameDraft, loadPriorRuns],
  );

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
            loadPriorRuns(); // reflect the finished run in the Prior runs list
            return;
          }
        }
      } catch {
        // transient — keep polling
      }
      timer.current = setTimeout(() => poll(id), POLL_MS);
    },
    [stopPoll, loadPriorRuns],
  );

  // Load a prior run into the results view: point the poller at it (a complete
  // run resolves on the first tick and stops). Clears the current selection.
  const loadPriorRun = useCallback(
    (id: string) => {
      if (id === searchId) return;
      stopPoll();
      setDetail(null);
      setSelected(new Set());
      setPage(1);
      setSaveMsg(null);
      setError(null);
      setResultsCollapsed(false);
      setSearchId(id);
    },
    [searchId, stopPoll],
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

  // Capture / restore the whole form for saved-search presets.
  const buildConfig = (): SearchConfig => ({
    query,
    jobTitles,
    locations,
    headcount: Array.from(headcount),
    seniority: Array.from(seniority),
    functions: Array.from(functions),
    industries: Array.from(industries),
    excludeTitles,
    currentCompanies,
    recentlyChanged,
    activePosters,
    autoSegment,
    addActivity,
    addVerify,
    depth,
    maxResults,
  });

  const applyConfig = (c: SearchConfig) => {
    setQuery(c.query ?? "");
    setJobTitles(c.jobTitles ?? []);
    setLocations(c.locations ?? []);
    setHeadcount(new Set(c.headcount ?? []));
    setSeniority(new Set(c.seniority ?? []));
    setFunctions(new Set(c.functions ?? []));
    setIndustries(new Set(c.industries ?? []));
    setExcludeTitles(c.excludeTitles ?? []);
    setCurrentCompanies(c.currentCompanies ?? []);
    setRecentlyChanged(Boolean(c.recentlyChanged));
    setActivePosters(Boolean(c.activePosters));
    // Deep search is opt-in ($0.10/page swept across segments, regardless of
    // yield). Presets saved before the toggle existed have no autoSegment key —
    // they must NOT silently enable it (that's how a 2-result search cost $1.10).
    setAutoSegment(c.autoSegment === true);
    setAddActivity(Boolean(c.addActivity));
    setAddVerify(Boolean(c.addVerify));
    if (c.depth) setDepth(c.depth);
    if (typeof c.maxResults === "number") setMaxResults(c.maxResults);
    // Reveal Advanced if the preset set anything that lives there.
    if (
      (c.excludeTitles?.length ?? 0) > 0 ||
      (c.currentCompanies?.length ?? 0) > 0 ||
      c.autoSegment === false
    ) {
      setAdvancedOpen(true);
    }
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
    setResultsCollapsed(false);
    try {
      const res = await fetch(appUrl("/api/admin/prospecting/linkedin-search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          levers: buildLevers(),
          depth,
          max_results: maxResults,
          name: searchNameInput.trim(),
          addons: { activity: addActivity, verify: addVerify },
        }),
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
  // Once an import kicks off enrichment, reveal the Email/Domain/Activity
  // columns so the Phase-2 overlay has somewhere to land — even for a Short
  // search that sourced no emails of its own.
  const showEnrichCols = enrichByUrl.size > 0 || importedUrls.size > 0;
  // How many imported rows have landed an email so far (live progress line).
  const enrichedEmailCount = useMemo(() => {
    let n = 0;
    for (const e of enrichByUrl.values()) if (e.email) n++;
    return n;
  }, [enrichByUrl]);
  // Email-outcome split for the results radial: a decision-maker (person) email —
  // from Full+email sourcing or the enrichment overlay — vs a company-only generic
  // inbox vs none yet. Fills in live as enrichment lands on each row.
  const emailOutcome = useMemo(() => {
    let person = 0;
    let company = 0;
    let none = 0;
    for (const r of results) {
      const en = r.linkedin_url ? enrichByUrl.get(LC(r.linkedin_url)) : undefined;
      if (r.email || en?.email) person++;
      else if (en?.company_email) company++;
      else none++;
    }
    return { person, company, none, total: results.length };
  }, [results, enrichByUrl]);
  // The table shows once sourcing completes, or mid-run as streamed rows arrive.
  const showResults = isComplete || (isRunning && results.length > 0);
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
  // Live Apify prices when loaded, else the static DEPTHS / ENRICH_RATES fallback.
  const rate = livePricing?.sourcing?.[depth] ?? depthMeta?.rate ?? 0.002;
  // Deep search multiplies the sourcing bill (see DEEP_SEARCH_MULTIPLIER).
  const estimate = rate * maxResults * (autoSegment ? DEEP_SEARCH_MULTIPLIER : 1);
  const emailRate = livePricing?.enrich.profile ?? ENRICH_RATES.email;
  const domainRate = livePricing?.enrich.domain ?? ENRICH_RATES.domain;
  // Activity is an add-on: costs only when toggled on AND not already covered by
  // the "active on LinkedIn" search filter (which makes the pass redundant).
  const activityRate =
    addActivity && !activePosters ? (livePricing?.enrich.activity ?? ENRICH_RATES.activity) : 0;
  // Verify is an add-on (Million Verifier credits, not an Apify list price).
  const verifyRate = addVerify ? ENRICH_RATES.verify : 0;
  // Website discovery — a web lookup for the subset of people whose company has
  // no LinkedIn page. Counted per-person as a small ceiling addition (only that
  // subset actually incurs it), unless discovery is turned off in settings.
  const discoveryRate = domainDiscoveryOn
    ? (livePricing?.enrich.domain_discovery ?? ENRICH_RATES.domain_discovery)
    : 0;
  const perPersonEnrich =
    emailRate + domainRate + ENRICH_RATES.waterfall + activityRate + verifyRate + discoveryRate;
  const projectedTotal = estimate + perPersonEnrich * maxResults;
  const pricesLive = livePricing?.source === "live" || livePricing?.source === "partial";
  // Est. cost per email type for the results radial, from the same live rates as
  // the estimate above: a person email via the email finders, a company inbox
  // from one site scrape, and "none" = the full per-contact spend that still
  // turned up nothing (the priciest outcome — it exhausts every method).
  const outcomeCosts = {
    person: emailRate,
    company: livePricing?.enrich.site_scrape ?? 0.003,
    none: perPersonEnrich,
  };

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
      // Remember what we just imported so those rows immediately read "Queued"
      // (the enrichment run's item rows take a tick or two to appear).
      setImportedUrls((prev) => {
        const next = new Set(prev);
        for (const u of selected) next.add(LC(u));
        return next;
      });
      setSelected(new Set());
      setAddOpen(false);
      loadPriorRuns(); // saved_count changed
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Add-ons for the live panel: a created/running search reflects its stored
  // choice; a fresh form reflects the current toggles.
  const panelAddons: EnrichmentAddons = detail?.query?.addons
    ? {
        activity: detail.query.addons.activity === true,
        verify: detail.query.addons.verify === true,
      }
    : { activity: addActivity, verify: addVerify };

  // Actual-spend breakdown (the "What did this cost?" popover). Sourcing +
  // enrichment are both real Apify usageTotalUsd figures; together they reconcile
  // the "Spend so far" number on the pipeline panel.
  const totalApify = actualCost + enrichRunCost;
  const ranDepth = (detail?.query?.depth as Depth | undefined) ?? depth;
  const ranDepthLabel = DEPTHS.find((d) => d.value === ranDepth)?.label ?? "Short";
  const ranDeepSearch = Boolean(
    (detail?.query as { levers?: { autoSegment?: boolean } } | null)?.levers?.autoSegment,
  );

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
          <div className="flex shrink-0 items-center gap-2">
            <SavedSearches getConfig={buildConfig} onLoad={applyConfig} />
            <button
              type="button"
              onClick={() => setInfoOpen("tips")}
              aria-haspopup="dialog"
              className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-medium text-[#2E37FE] hover:bg-[#EDEEFF]/50"
            >
              <HelpCircle size={14} />
              How to search
            </button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Optional name for this run — the label it carries in Prior runs
              and above the results (renamable there too). */}
          <div className="space-y-1.5">
            <Label>
              Search name{" "}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              value={searchNameInput}
              onChange={(e) => setSearchNameInput(e.target.value)}
              maxLength={80}
              placeholder="e.g. Commercial cleaning — US founders"
              style={{ height: 38 }}
            />
            <p className="text-[11px] text-muted-foreground">
              Labels this run in Prior runs and above the results. Leave blank to
              auto-name it from your filters — you can rename it any time.
            </p>
          </div>

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

          {/* Enrichment add-ons — opt-in stages that extend the pipeline. */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Enrichment add-ons
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              The base pipeline finds each person&apos;s email, company domain, and a
              verified 2nd-pass email. Add more depth:
            </p>
            <div className="mt-2 space-y-2">
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={addActivity}
                  onChange={(e) => setAddActivity(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-[#2E37FE]"
                />
                <span>
                  Activity check
                  <span className="block text-[11px] text-muted-foreground">
                    Scores each person&apos;s LinkedIn posting recency (last 30 days).
                    {activePosters
                      ? " Already covered by your “Active on LinkedIn” filter — will be skipped."
                      : ""}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={addVerify}
                  onChange={(e) => setAddVerify(e.target.checked)}
                  className="mt-0.5 h-4 w-4 cursor-pointer rounded border-border accent-[#2E37FE]"
                />
                <span>
                  Email verification
                  <span className="block text-[11px] text-muted-foreground">
                    Verifies every found email with Million Verifier so your report shows
                    valid / risky / invalid.
                  </span>
                </span>
              </label>
            </div>
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
              <div className="mt-3 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
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
                {/* Deep search — the default; opt out here only for a cheap single-query search. */}
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/60 pt-3">
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
                    Only for bulk pulls beyond ~2,500 matches per query (sweeps sub-queries).{" "}
                    <span className="font-medium text-amber-600">Paid Apify only</span> — the free tier returns 0 with this on.
                  </span>
                  <InfoButton label="About Deep search" onClick={() => setInfoOpen("segment")} />
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
                {pricesLive && (
                  <span
                    title="Prices pulled live from Apify"
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600"
                  >
                    <span className="h-1 w-1 rounded-full bg-emerald-500" />
                    live
                  </span>
                )}
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
        addons={panelAddons}
        autoRun={autoRun}
      />
      </div>

      {/* Prior runs — collapsible. Click a run to reload its results (no new
          Apify charge; a completed run resolves on the first poll tick). */}
      {priorRuns.length > 0 && (
        <Card className="border-border/50 shadow-sm">
          <button
            type="button"
            onClick={() => setPriorOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-500">
              <History size={15} className="text-white" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold">Prior runs</p>
              <p className="text-[11px] text-muted-foreground">
                {priorRuns.length} recent search{priorRuns.length === 1 ? "" : "es"} · reload results free
              </p>
            </div>
            <ChevronRight
              size={16}
              className={`shrink-0 text-muted-foreground transition-transform ${priorOpen ? "rotate-90" : ""}`}
            />
          </button>
          {priorOpen && (
            <div className="border-t border-border/60 p-2">
              <div className="space-y-1">
                {priorRuns.map((r) => {
                  const active = r.id === searchId;
                  const editing = renamingId === r.id;
                  return (
                    <div
                      key={r.id}
                      className={`group flex items-center gap-1.5 rounded-md border px-2 transition-colors ${
                        active ? "border-[#2E37FE] bg-[#EDEEFF]" : "border-transparent hover:bg-muted/50"
                      }`}
                    >
                      {editing ? (
                        <div className="flex flex-1 items-center gap-1.5 py-1.5">
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveRename(r.id);
                              } else if (e.key === "Escape") {
                                cancelRename();
                              }
                            }}
                            placeholder="Name this search"
                            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 text-[12.5px] outline-none focus:border-[#2E37FE]"
                          />
                          <button
                            type="button"
                            onClick={() => saveRename(r.id)}
                            aria-label="Save name"
                            className="shrink-0 rounded p-1 text-emerald-600 hover:bg-emerald-50"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={cancelRename}
                            aria-label="Cancel rename"
                            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => loadPriorRun(r.id)}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 text-left"
                          >
                            <PriorStatusIcon status={r.status} />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[13px] font-medium">{searchName(r.query)}</p>
                              <p className="text-[11px] text-muted-foreground">
                                {r.status === "complete" ? (
                                  <>
                                    {r.result_count.toLocaleString()} found
                                    {r.saved_count ? ` · ${r.saved_count} imported` : ""}
                                    {" · "}
                                    {timeAgoShort(r.completed_at ?? r.created_at)}
                                  </>
                                ) : r.status === "running" ? (
                                  <span className="text-blue-600">Running…</span>
                                ) : r.status === "pending" ? (
                                  <span className="text-amber-600">Queued</span>
                                ) : (
                                  <span className="text-red-600">Failed</span>
                                )}
                              </p>
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => startRename(r.id, r.query?.name ?? "")}
                            aria-label={`Rename ${searchName(r.query)}`}
                            title="Rename search"
                            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-[#EDEEFF] hover:text-[#2E37FE]"
                          >
                            <Pencil size={13} />
                          </button>
                          <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                            ${(Number(r.cost_usd) || 0).toFixed(2)}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      )}

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
          <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11.5px] text-amber-800">
            <span className="font-semibold">Requires a paid Apify plan.</span> On the free Apify tier
            the actor refuses to segment and the search comes back with{" "}
            <span className="font-medium">0 results</span>. (The free tier also caps every run at 25
            items — a plan limit, not this feature.)
          </div>
          <p>
            LinkedIn won&apos;t return more than{" "}
            <span className="font-medium text-foreground">~2,500 results for a single search query</span>.
            Deep search gets past that ceiling by{" "}
            <span className="font-medium text-foreground">
              splitting your search into many narrower sub-queries
            </span>{" "}
            — by country, state, then seniority — and sweeping across them, deduping, until it reaches
            your Max people. It&apos;s a tool for <span className="font-medium text-foreground">bulk pulls</span>.
          </p>
          <div>
            <p className="font-medium text-foreground">You probably don&apos;t need it</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                On a paid plan, a{" "}
                <span className="font-medium">normal search already returns up to your Max people</span>{" "}
                (anything up to 2,500 per query) — no segmentation required.
              </li>
              <li>
                Only turn it on when you genuinely want{" "}
                <span className="font-medium">more than ~2,500 matches</span> in one run. It also costs
                more (a search page per slice).
              </li>
            </ul>
          </div>
          <p className="rounded-md bg-[#EDEEFF]/70 px-2.5 py-2 text-[11px]">
            Seeing only 25 results? That&apos;s the{" "}
            <span className="font-medium text-foreground">free Apify tier&apos;s per-run cap</span> —
            upgrade the plan and a normal search returns up to your Max people, no Deep search needed.
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
                ${rate.toFixed(4)} × {maxResults.toLocaleString()}
                {autoSegment ? ` × ${DEEP_SEARCH_MULTIPLIER} deep` : ""} = ${estimate.toFixed(2)}
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
                <span className="font-mono tabular-nums">${emailRate.toFixed(4)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Company → domain · <span className="font-mono">linkedin-company</span></span>
                <span className="font-mono tabular-nums">${domainRate.toFixed(4)}</span>
              </div>
              {domainDiscoveryOn && (
                <div className="flex items-center justify-between">
                  <span>
                    Website discovery · <span className="font-mono">web lookup</span>{" "}
                    <span className="text-[9px] text-muted-foreground">(companies with no LinkedIn page)</span>
                  </span>
                  <span className="font-mono tabular-nums">${discoveryRate.toFixed(4)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span>2nd-pass email · <span className="font-mono">pattern + verify</span> (misses)</span>
                <span className="font-mono tabular-nums">${ENRICH_RATES.waterfall.toFixed(4)}</span>
              </div>
              {addActivity && (
                <div className="flex items-center justify-between">
                  <span>
                    Activity · <span className="font-mono">profile-posts</span>
                    {activePosters ? " (skipped)" : ""} <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  </span>
                  <span className="font-mono tabular-nums">${activityRate.toFixed(4)}</span>
                </div>
              )}
              {addVerify && (
                <div className="flex items-center justify-between">
                  <span>
                    Verify · Million Verifier{" "}
                    <span className="text-[9px] uppercase tracking-wide text-[#2E37FE]/70">add-on</span>
                  </span>
                  <span className="font-mono tabular-nums">${verifyRate.toFixed(4)}</span>
                </div>
              )}
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
            A ceiling, not a bill: sourcing charges only for profiles the actor can return; enrichment bills only on people you actually import (usually a subset), and each waterfall pass only touches people the previous one left without an email. Activity and verification bill only when you toggle them on above. With Deep search on, sourcing sweeps sub-queries to actually reach your Max people, so the sourcing figure is realistic rather than a rarely-hit ceiling.
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

      <InfoDialog
        open={infoOpen === "actual"}
        onClose={() => setInfoOpen(null)}
        title="What did this cost?"
      >
        <div className="space-y-3 text-[12px] text-muted-foreground">
          <p>
            Every figure below is the <span className="font-medium text-foreground">actual</span> amount
            Apify billed for each run (its <span className="font-mono">usageTotalUsd</span>), not an
            estimate.
          </p>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span>
                Sourcing · <span className="font-mono">profile-search</span>
              </span>
              <span className="font-mono tabular-nums font-medium text-foreground">
                ${actualCost.toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/80">
              {detail?.result_count ?? 0} profiles returned · {ranDepthLabel}
              {ranDeepSearch ? " · Deep search on" : ""}
            </p>
          </div>

          <div className="space-y-1 border-t border-border/60 pt-2">
            <div className="flex items-center justify-between">
              <span>Enrichment · this run</span>
              <span className="font-mono tabular-nums font-medium text-foreground">
                ${enrichRunCost.toFixed(2)}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground/80">
              across <span className="font-mono">profile-scraper</span>,{" "}
              <span className="font-mono">linkedin-company</span>, the 2nd-pass finder
              {panelAddons.activity ? (
                <>
                  , and <span className="font-mono">profile-posts</span>
                </>
              ) : (
                ""
              )}
              {panelAddons.verify ? " + Million Verifier" : ""} — billed only on the people you
              imported.
            </p>
          </div>

          <div className="flex items-center justify-between rounded-md bg-[#EDEEFF]/70 px-2 py-1.5 font-medium text-foreground">
            <span>Total Apify spend</span>
            <span className="font-mono tabular-nums">${totalApify.toFixed(2)}</span>
          </div>

          <p className="text-[11px]">
            Sourcing is billed for <span className="font-medium text-foreground">total work</span>, not
            the profiles you keep: <span className="font-mono">Full + email</span> opens each profile
            for an email lookup (~$10/1k), and <span className="font-medium text-foreground">Deep
            search</span> sweeps sub-queries — opening far more profiles than the
            {" "}{detail?.result_count ?? 0} it returns after de-duplication. That&apos;s why the
            per-returned-profile figure looks high. To cut it, drop to{" "}
            <span className="font-medium text-foreground">Short</span> depth and let the enrichment
            waterfall find emails only on the people you import.
          </p>
        </div>
      </InfoDialog>

      {/* Results — appears the moment sourced rows stream in (Phase 1) and
          gains live Email/Domain/Activity columns as enrichment lands (Phase 2). */}
      {showResults && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div
                  className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                    isRunning ? "bg-[#2E37FE]" : "bg-emerald-500"
                  }`}
                >
                  {isRunning ? (
                    <Loader2 size={16} className="animate-spin text-white" />
                  ) : (
                    <CheckCircle2 size={16} className="text-white" />
                  )}
                </div>
                <div className="min-w-0">
                  {/* Editable search name — custom label, else the ICP summary. */}
                  {searchId && renamingId === searchId ? (
                    <div className="mb-1 flex items-center gap-1.5">
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            saveRename(searchId);
                          } else if (e.key === "Escape") {
                            cancelRename();
                          }
                        }}
                        placeholder="Name this search"
                        className="w-[220px] max-w-full rounded-md border border-input bg-background px-2 py-0.5 text-[12px] outline-none focus:border-[#2E37FE]"
                      />
                      <button
                        type="button"
                        onClick={() => saveRename(searchId)}
                        aria-label="Save name"
                        className="rounded p-0.5 text-emerald-600 hover:bg-emerald-50"
                      >
                        <Check size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={cancelRename}
                        aria-label="Cancel rename"
                        className="rounded p-0.5 text-muted-foreground hover:bg-muted"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    searchId && (
                      <button
                        type="button"
                        onClick={() => startRename(searchId, detail?.query?.name ?? "")}
                        title={detail?.query?.name ? "Rename this search" : "Name this search"}
                        className="mb-1 inline-flex max-w-full items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-[#2E37FE]/60 hover:bg-[#EDEEFF]/50 hover:text-[#2E37FE]"
                      >
                        <Pencil size={11} className="shrink-0" />
                        <span className="truncate">
                          {detail?.query?.name ? detail.query.name : `Name this search (${searchName(detail?.query)})`}
                        </span>
                      </button>
                    )
                  )}
                  <CardTitle className="text-base">
                    {isRunning
                      ? `Sourcing… ${(detail?.result_count ?? results.length).toLocaleString()} found`
                      : `${results.length.toLocaleString()} ${results.length === 1 ? "person" : "people"} found`}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {isRunning
                      ? "Rows stream in as they're scraped — select any to import"
                      : selected.size > 0
                        ? `${selected.size} selected`
                        : "Select people to import"}
                    {hasEmails && (
                      <span className="ml-1 text-emerald-600">· {emailCount} with email</span>
                    )}
                    {showEnrichCols && (
                      <span className="ml-1 text-[#2E37FE]">
                        · enrichment found {enrichedEmailCount} email
                        {enrichedEmailCount === 1 ? "" : "s"}
                      </span>
                    )}
                    {detail?.truncated && (
                      <span className="ml-1 text-amber-600">· more available — raise the cap</span>
                    )}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {selected.size > 0 && (
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
                )}
                <button
                  type="button"
                  onClick={() => setResultsCollapsed((v) => !v)}
                  aria-label={resultsCollapsed ? "Expand results" : "Collapse results"}
                  aria-expanded={!resultsCollapsed}
                  title={resultsCollapsed ? "Expand" : "Collapse"}
                  className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <ChevronDown
                    size={18}
                    className={`transition-transform ${resultsCollapsed ? "-rotate-90" : ""}`}
                  />
                </button>
              </div>
            </div>
          </CardHeader>
          {!resultsCollapsed && (
          <CardContent className="space-y-3">
            {/* Email-outcome radial — person vs company-only vs none. Shows once
                there's email data (Full+email sourcing or enrichment underway). */}
            {(hasEmails || showEnrichCols) && (
              <div className="rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
                <EmailOutcomeRadial {...emailOutcome} costs={outcomeCosts} />
              </div>
            )}
            {/* Add-to-campaign inline panel */}
            {addOpen && selected.size > 0 && (
              <div className="rounded-lg border border-[#2E37FE]/30 bg-[#EDEEFF]/40 p-4">
                <p className="text-sm font-medium text-[#1C24B8]">
                  Import {selected.size} to Contacts
                </p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  Pick a campaign to assign them to, or import without one. Enrichment runs here and
                  the columns below fill in live.
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

            {/* table-fixed + per-cell truncation keeps every column inside the
                card — no horizontal scroll — while whitespace-nowrap (from the
                Table primitives) keeps every row a single, uniform line. When
                the enrichment columns are live, Headline + Location step aside
                so Email/Domain/Activity/Status fit without crowding. */}
            <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <input
                        type="checkbox"
                        checked={allPageSelected}
                        onChange={togglePage}
                        className="accent-[#2E37FE]"
                        aria-label="Select all on page"
                      />
                    </TableHead>
                    <TableHead>Name</TableHead>
                    {!showEnrichCols && (
                      <TableHead className="hidden md:table-cell">Headline</TableHead>
                    )}
                    <TableHead>Company</TableHead>
                    {(hasEmails || showEnrichCols) && (
                      <TableHead>
                        <span className="inline-flex items-center gap-1">
                          <Mail size={12} /> Email
                        </span>
                      </TableHead>
                    )}
                    {showEnrichCols && (
                      <TableHead className="hidden w-[128px] sm:table-cell">
                        <span className="inline-flex items-center gap-1">
                          <Globe size={12} /> Domain
                        </span>
                      </TableHead>
                    )}
                    {showEnrichCols && (
                      <TableHead className="hidden w-[92px] xl:table-cell">
                        <span className="inline-flex items-center gap-1">
                          <Activity size={12} /> Activity
                        </span>
                      </TableHead>
                    )}
                    {showEnrichCols && <TableHead className="w-[112px]">Status</TableHead>}
                    {!showEnrichCols && (
                      <TableHead className="hidden lg:table-cell">Location</TableHead>
                    )}
                    <TableHead className="w-9"></TableHead>
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
                    const en = url ? enrichByUrl.get(LC(url)) : undefined;
                    const imported = Boolean(en) || Boolean(url && importedUrls.has(LC(url)));
                    const emailVal = en?.email ?? r.email ?? null;
                    const companyEmailVal = en?.company_email ?? null;
                    const emailLoading =
                      !emailVal && !companyEmailVal && !!en &&
                      (isStepActive(en.profile_status) || isStepActive(en.waterfall_status));
                    const domainVal = en?.company_domain ?? r.company_domain ?? null;
                    const domainLoading = !domainVal && !!en && isStepActive(en.domain_status);
                    const activityVal = en?.last_posted_at ? timeAgoShort(en.last_posted_at) : null;
                    const activityLoading = !activityVal && !!en && isStepActive(en.activity_status);
                    return (
                      <TableRow key={url || i} data-state={on ? "selected" : undefined}>
                        <TableCell className="w-8">
                          <input
                            type="checkbox"
                            checked={Boolean(on)}
                            onChange={() => url && toggleRow(url)}
                            disabled={!url}
                            className="accent-[#2E37FE]"
                            aria-label={`Select ${name}`}
                          />
                        </TableCell>
                        <TableCell className="truncate font-medium" title={name}>
                          {name}
                        </TableCell>
                        {!showEnrichCols && (
                          <TableCell
                            className="hidden truncate text-muted-foreground md:table-cell"
                            title={r.headline ?? undefined}
                          >
                            {r.headline ?? "—"}
                          </TableCell>
                        )}
                        <TableCell className="truncate" title={r.company_name ?? undefined}>
                          {r.company_name ?? "—"}
                        </TableCell>
                        {(hasEmails || showEnrichCols) && (
                          <TableCell
                            className="truncate font-mono text-[12px]"
                            title={emailVal ?? companyEmailVal ?? undefined}
                          >
                            <EmailCell person={emailVal} company={companyEmailVal} loading={emailLoading} />
                          </TableCell>
                        )}
                        {showEnrichCols && (
                          <TableCell
                            className="hidden truncate font-mono text-[12px] text-muted-foreground sm:table-cell"
                            title={domainVal ?? undefined}
                          >
                            <EnrichCell value={domainVal} loading={domainLoading} />
                          </TableCell>
                        )}
                        {showEnrichCols && (
                          <TableCell className="hidden text-[12px] text-muted-foreground xl:table-cell">
                            <EnrichCell value={activityVal} loading={activityLoading} plain />
                          </TableCell>
                        )}
                        {showEnrichCols && (
                          <TableCell>
                            <RowStatusBadge en={en} imported={imported} />
                          </TableCell>
                        )}
                        {!showEnrichCols && (
                          <TableCell
                            className="hidden truncate text-muted-foreground lg:table-cell"
                            title={r.location ?? undefined}
                          >
                            {r.location ?? "—"}
                          </TableCell>
                        )}
                        <TableCell className="w-9">
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
            <PaginationControls
              currentPage={page}
              totalItems={results.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
            {isComplete && (
              <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
                <span>Actual Apify cost for this search — billed per profile returned, not per target</span>
                <span className="flex items-center gap-1.5">
                  <span className="font-mono tabular-nums font-medium text-foreground">
                    ${actualCost.toFixed(2)}
                  </span>
                  <InfoButton label="What did this cost?" onClick={() => setInfoOpen("actual")} />
                </span>
              </div>
            )}
          </CardContent>
          )}
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

// ---- Live-review helpers (Phase 2 per-row overlay) ----

function isStepActive(s: EnrichmentStepish): boolean {
  return s === "pending" || s === "in_flight";
}

// One enrichment value cell: the value once found, a spinner while its step is
// still running, an em dash when the step finished without one.
function EnrichCell({
  value,
  loading,
  plain = false,
}: {
  value: string | null;
  loading: boolean;
  plain?: boolean;
}) {
  if (value)
    return <span className={plain ? "text-foreground" : "text-foreground"}>{value}</span>;
  if (loading) return <Loader2 size={13} className="animate-spin text-[#2E37FE]" />;
  return <span className="text-muted-foreground">—</span>;
}

// The Email cell, color-coded to match the Email-outcomes radial: a person's
// direct address in blue, or — when that's all we found — the company's generic
// inbox in green with a "company" tag so it's never mistaken for a personal one.
function EmailCell({
  person,
  company,
  loading,
}: {
  person: string | null;
  company: string | null;
  loading: boolean;
}) {
  if (person) return <span style={{ color: "#2E37FE" }}>{person}</span>;
  if (company)
    return (
      <span className="inline-flex items-center gap-1" style={{ color: "#10b981" }}>
        <span className="truncate">{company}</span>
        <span className="shrink-0 rounded bg-emerald-50 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-emerald-600">
          company
        </span>
      </span>
    );
  if (loading) return <Loader2 size={13} className="animate-spin text-[#2E37FE]" />;
  return <span className="text-muted-foreground">—</span>;
}

// Per-row import/enrichment state pill. Blank until the row is imported, then
// Queued → Enriching → Enriched as the run works through its steps.
function RowStatusBadge({
  en,
  imported,
}: {
  en: EnrichLite | undefined;
  imported: boolean;
}) {
  if (!imported) return <span className="text-xs text-muted-foreground">—</span>;
  if (!en) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
        <Clock size={10} /> Queued
      </span>
    );
  }
  const active =
    isStepActive(en.profile_status) ||
    isStepActive(en.domain_status) ||
    isStepActive(en.waterfall_status) ||
    isStepActive(en.activity_status);
  if (active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#EDEEFF] px-1.5 py-0.5 text-[10px] font-medium text-[#1C24B8]">
        <Loader2 size={10} className="animate-spin" /> Enriching
      </span>
    );
  }
  if (en.email) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
        <CheckCircle2 size={10} /> Enriched
      </span>
    );
  }
  // Terminal, but no email landed — still done, just nothing to send to.
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
      <XCircle size={10} /> No email
    </span>
  );
}

function PriorStatusIcon({ status }: { status: LinkedInSearchStatus }) {
  if (status === "complete") return <CheckCircle2 size={15} className="shrink-0 text-emerald-600" />;
  if (status === "running") return <Loader2 size={15} className="shrink-0 animate-spin text-blue-600" />;
  if (status === "pending") return <Clock size={15} className="shrink-0 text-amber-600" />;
  return <XCircle size={15} className="shrink-0 text-red-600" />;
}

// Email-outcome radial for a search's results: a decision-maker (person) email vs
// a company-only generic inbox vs none yet. Fills in live as enrichment lands.
function EmailOutcomeRadial({
  person,
  company,
  none,
  total,
  costs,
}: {
  person: number;
  company: number;
  none: number;
  total: number;
  costs?: { person: number; company: number; none: number };
}) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
  // Colors: person = blue, company = green (flipped from the usual "best = green"
  // so the same palette carries into the results Email column).
  const segs = [
    { key: "person" as const, v: person, color: "#2E37FE", label: "Person email" },
    { key: "company" as const, v: company, color: "#10b981", label: "Company only" },
    { key: "none" as const, v: none, color: "#94a3b8", label: "No email" },
  ];
  const withEmail = person + company;
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
        <p className="mb-1.5 flex items-baseline justify-between gap-2 text-[12px] font-semibold">
          Email outcomes
          {costs && (
            <span className="text-[9px] font-normal uppercase tracking-wide text-muted-foreground/60">
              est. $/email
            </span>
          )}
        </p>
        <div className="space-y-0.5">
          {segs.map((s) => (
            <div
              key={s.key}
              className="flex items-center gap-2 border-b border-dashed border-border/60 py-[3px] text-[11.5px] last:border-b-0"
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto font-mono font-semibold tabular-nums">{s.v}</span>
              {costs && (
                <span className="w-[58px] text-right font-mono tabular-nums text-muted-foreground/80">
                  {money(costs[s.key])}
                  <span className="text-muted-foreground/50">/ea</span>
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
