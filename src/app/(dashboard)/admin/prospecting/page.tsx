"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  AlertTriangle,
  Loader2,
  Sparkles,
  MapPin,
  Building2,
  Map as MapIcon,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  History,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { ScrapioBusiness, ProspectSearchStatus } from "@/types/app";
import { Typeahead, type TypeaheadResult } from "./typeahead";

type Filters = {
  has_website: boolean;
  has_phone: boolean;
  has_email: boolean;
  claimed: boolean;
  main_activity_only: boolean;
};

const DEFAULT_FILTERS: Filters = {
  has_website: false,
  has_phone: false,
  has_email: false,
  claimed: false,
  main_activity_only: false,
};

const FILTER_LABELS: Record<keyof Filters, string> = {
  has_website: "Has website",
  has_phone: "Has phone",
  has_email: "Has scraped email",
  claimed: "Claimed (verified)",
  main_activity_only: "Main category only",
};

const MAX_RESULTS_OPTIONS = [100, 500, 1000, 2500, 5000] as const;
const HARD_RESULT_CAP = 5000;
const POLL_INTERVAL_MS = 3000;

type LocationBadge = {
  label: string;
  color: string;
  Icon: typeof MapIcon;
};

const LOCATION_BADGES: Record<string, LocationBadge> = {
  admin1: {
    label: "State",
    color: "bg-blue-50 text-blue-700 border-blue-200",
    Icon: MapIcon,
  },
  admin2: {
    label: "County",
    color: "bg-amber-50 text-amber-700 border-amber-200",
    Icon: Building2,
  },
  city: {
    label: "City",
    color: "bg-emerald-50 text-emerald-700 border-emerald-200",
    Icon: MapPin,
  },
};

type SearchSummary = {
  id: string;
  query: Record<string, unknown>;
  result_count: number;
  pages_fetched: number;
  truncated: boolean;
  status: ProspectSearchStatus;
  started_at: string | null;
  completed_at: string | null;
  progress_message: string | null;
  error_message: string | null;
  target_max_results: number;
  created_at: string;
};

type SearchDetail = SearchSummary & {
  results: ScrapioBusiness[];
};

function describeQuery(query: Record<string, unknown>): string {
  const cat = (query.type as string) || "—";
  const admin1 = (query.admin1_code as string) || "";
  const admin2 = (query.admin2_code as string | null) || "";
  const city = (query.city as string | null) || "";
  const loc = city
    ? `${city}, ${admin1}`
    : admin2
      ? `county ${admin2}, ${admin1}`
      : admin1;
  return `${cat} · ${loc}`;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function ProspectingPage() {
  const [categoryInput, setCategoryInput] = useState("");
  const [selectedCategory, setSelectedCategory] =
    useState<TypeaheadResult | null>(null);

  const [locationInput, setLocationInput] = useState("");
  const [selectedLocation, setSelectedLocation] =
    useState<TypeaheadResult | null>(null);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [maxResults, setMaxResults] = useState<number>(500);

  const [activeSearchId, setActiveSearchId] = useState<string | null>(null);
  const [activeSearch, setActiveSearch] = useState<SearchDetail | null>(null);
  const [recentSearches, setRecentSearches] = useState<SearchSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRecentSearches = useCallback(async () => {
    const res = await fetch(appUrl("/api/admin/prospecting/searches"), {
      cache: "no-store",
    });
    if (!res.ok) return;
    const data = await res.json();
    setRecentSearches(
      Array.isArray(data.searches) ? (data.searches as SearchSummary[]) : [],
    );
  }, []);

  const loadSearchDetail = useCallback(async (id: string) => {
    const res = await fetch(
      appUrl(`/api/admin/prospecting/searches/${id}`),
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.search as SearchDetail) ?? null;
  }, []);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollOnce = useCallback(
    async (id: string) => {
      const detail = await loadSearchDetail(id);
      if (!detail) return;
      setActiveSearch(detail);
      if (detail.status === "complete" || detail.status === "failed") {
        stopPolling();
        loadRecentSearches();
        return;
      }
      pollTimerRef.current = setTimeout(() => pollOnce(id), POLL_INTERVAL_MS);
    },
    [loadRecentSearches, loadSearchDetail, stopPolling],
  );

  useEffect(() => {
    loadRecentSearches();
    return () => stopPolling();
  }, [loadRecentSearches, stopPolling]);

  useEffect(() => {
    if (!activeSearchId) {
      stopPolling();
      return;
    }
    setSelected(new Set());
    pollOnce(activeSearchId);
    return () => stopPolling();
  }, [activeSearchId, pollOnce, stopPolling]);

  function clearCategory() {
    setSelectedCategory(null);
    setCategoryInput("");
  }

  function clearLocation() {
    setSelectedLocation(null);
    setLocationInput("");
  }

  async function searchCategories(term: string): Promise<TypeaheadResult[]> {
    const res = await fetch(appUrl("/api/admin/prospecting/typeahead/type"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ search_term: term }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  }

  async function searchLocations(term: string): Promise<TypeaheadResult[]> {
    const res = await fetch(
      appUrl("/api/admin/prospecting/typeahead/location"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search_term: term }),
      },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  }

  async function handleSearch() {
    if (!selectedCategory) {
      setSubmitError("Pick a category from the dropdown first.");
      return;
    }
    if (!selectedLocation) {
      setSubmitError(
        "Pick a location (state, county, or city) from the dropdown first.",
      );
      return;
    }
    setSubmitting(true);
    setSubmitError(null);

    const body: Record<string, unknown> = {
      type: selectedCategory.id,
      max_results: maxResults,
      filters,
    };
    if (selectedLocation.search_type === "admin1") {
      body.admin1_code = selectedLocation.id;
    } else if (selectedLocation.search_type === "admin2") {
      body.admin1_code = selectedLocation.parent_admin1;
      body.admin2_code = selectedLocation.id;
    } else if (selectedLocation.search_type === "city") {
      const cityName = selectedLocation.text.split(",")[0].trim();
      body.admin1_code = selectedLocation.parent_admin1;
      body.city = cityName;
    } else {
      setSubmitError("Selected location is missing a type. Pick again.");
      setSubmitting(false);
      return;
    }

    try {
      const res = await fetch(appUrl("/api/admin/prospecting/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.search_id) {
        setSubmitError(data.error ?? "Failed to queue search");
      } else {
        setActiveSearchId(data.search_id);
        setActiveSearch(null);
        loadRecentSearches();
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to queue search");
    } finally {
      setSubmitting(false);
    }
  }

  function rowKey(r: ScrapioBusiness): string {
    return r.google_id || `${r.name}-${r.full_address}`;
  }

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleAll() {
    if (!activeSearch) return;
    setSelected((prev) => {
      if (prev.size === activeSearch.results.length) return new Set();
      return new Set(activeSearch.results.map(rowKey));
    });
  }

  function handleSaveSelected() {
    alert(
      `Save flow lands in Phase 3.\nSelected ${selected.size} of ${activeSearch?.results.length ?? 0}.`,
    );
  }

  const locationBadge =
    selectedLocation?.search_type
      ? LOCATION_BADGES[selectedLocation.search_type]
      : null;

  const showProgress =
    activeSearch &&
    (activeSearch.status === "pending" || activeSearch.status === "running");
  const showError = activeSearch?.status === "failed";
  const showResults = activeSearch?.status === "complete";

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Lead generation</p>
          <h1
            className="text-[20px] sm:text-[22px] font-bold mt-1 flex items-center gap-2"
            style={{ color: "#0f172a", letterSpacing: "-0.01em" }}
          >
            <Sparkles size={20} /> Prospecting
          </h1>
          <p className="text-sm text-[#0f172a]/60 mt-1">
            Search Scrap.io by category and location, then save selected leads
            into your CRM pipeline. Searches run in the background — close the
            tab and come back any time.
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Recent searches */}
      {recentSearches.length > 0 && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center gap-2 pb-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-500">
              <History size={16} className="text-white" />
            </div>
            <div>
              <CardTitle className="text-base">Recent searches</CardTitle>
              <p className="text-xs text-muted-foreground">
                Click to reload cached results — no Scrap.io credits charged.
              </p>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {recentSearches.map((s) => {
                const isActive = s.id === activeSearchId;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setActiveSearchId(s.id)}
                    className={`w-full text-left flex items-center gap-3 rounded-md border px-3 py-2 transition-colors cursor-pointer ${
                      isActive
                        ? "border-[#2E37FE] bg-[#EDEEFF]"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <SearchStatusIcon status={s.status} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {describeQuery(s.query)}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {s.status === "complete" && (
                          <>
                            {s.result_count.toLocaleString()} results · {s.pages_fetched} pages
                            {s.truncated && (
                              <span className="ml-1 text-amber-600">(truncated)</span>
                            )}
                            {" · "}
                            {timeAgo(s.completed_at ?? s.created_at)}
                          </>
                        )}
                        {s.status === "running" && (
                          <span className="text-blue-600">
                            {s.progress_message ?? "Running…"}
                          </span>
                        )}
                        {s.status === "pending" && (
                          <span className="text-amber-600">Queued</span>
                        )}
                        {s.status === "failed" && (
                          <span className="text-red-600">
                            Failed: {s.error_message ?? "unknown error"}
                          </span>
                        )}
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
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Search size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">New search</CardTitle>
            <p className="text-xs text-muted-foreground">
              Burns Scrap.io credits on each run. Already-fetched businesses
              are auto-blacklisted so re-running similar searches won't double-charge.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Category typeahead */}
          <div className="space-y-1">
            <Label htmlFor="category" className="text-sm font-medium">
              Category <span className="text-red-500">*</span>
            </Label>
            {selectedCategory ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                <span className="text-sm font-medium flex-1 truncate">
                  {selectedCategory.text}
                </span>
                <span className="text-[11px] font-mono text-muted-foreground">
                  {selectedCategory.id}
                </span>
                <button
                  type="button"
                  onClick={clearCategory}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                  aria-label="Clear category"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <Typeahead
                id="category"
                variant="category"
                placeholder="Type 2+ chars — e.g. plumber, dentist, lawyer"
                value={categoryInput}
                onValueChange={setCategoryInput}
                onSelect={(item) => {
                  setSelectedCategory(item);
                  setCategoryInput(item.text);
                }}
                onSearch={searchCategories}
              />
            )}
          </div>

          {/* Location typeahead */}
          <div className="space-y-1">
            <Label htmlFor="location" className="text-sm font-medium">
              Location <span className="text-red-500">*</span>
            </Label>
            {selectedLocation ? (
              <div className="flex items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2">
                <span className="text-sm font-medium flex-1 truncate">
                  {selectedLocation.text}
                </span>
                {locationBadge && (
                  <span
                    className={`flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${locationBadge.color}`}
                  >
                    <locationBadge.Icon size={11} />
                    {locationBadge.label}
                  </span>
                )}
                <button
                  type="button"
                  onClick={clearLocation}
                  className="text-muted-foreground hover:text-foreground cursor-pointer"
                  aria-label="Clear location"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <Typeahead
                id="location"
                variant="location"
                placeholder="Type 2+ chars — state, county, or city"
                value={locationInput}
                onValueChange={setLocationInput}
                onSelect={(item) => {
                  setSelectedLocation(item);
                  setLocationInput(item.text);
                }}
                onSearch={searchLocations}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Pick a State, County, or City. Counties and cities narrow the
              search to the area inside the parent state.
            </p>
          </div>

          {/* Filters */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Filters</Label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {(Object.keys(FILTER_LABELS) as (keyof Filters)[]).map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 text-sm cursor-pointer rounded-md border border-border/60 px-3 py-2 hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    checked={filters[key]}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, [key]: e.target.checked }))
                    }
                    className="cursor-pointer"
                  />
                  <span>{FILTER_LABELS[key]}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Max results */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Max results</Label>
            <div className="flex flex-wrap gap-2 items-center">
              {MAX_RESULTS_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setMaxResults(n)}
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors cursor-pointer ${
                    maxResults === n
                      ? "bg-[#2E37FE] text-white border-[#2E37FE]"
                      : "bg-white text-foreground border-border hover:bg-muted/40"
                  }`}
                >
                  {n.toLocaleString()}
                </button>
              ))}
              <div className="flex items-center gap-2 ml-2">
                <span className="text-xs text-muted-foreground">Custom:</span>
                <Input
                  type="number"
                  min={1}
                  max={HARD_RESULT_CAP}
                  value={maxResults}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n >= 1) {
                      setMaxResults(Math.min(n, HARD_RESULT_CAP));
                    }
                  }}
                  className="w-28 h-8"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Hard cap is {HARD_RESULT_CAP.toLocaleString()} per search. Each ~50
              results = roughly one Scrap.io API call. A 5,000-result search
              finishes in ~13 minutes (cron runs every minute, processes 8 pages
              per tick).
            </p>
          </div>

          {/* Search button */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={handleSearch}
              disabled={submitting}
              style={{ background: "#2E37FE" }}
            >
              {submitting ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-2" /> Queuing…
                </>
              ) : (
                <>
                  <Search size={14} className="mr-2" /> Search up to {maxResults.toLocaleString()}
                </>
              )}
            </Button>
            {submitError && (
              <span className="text-sm text-red-600">{submitError}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Active search: progress / error / results */}
      {showProgress && activeSearch && (
        <Card className="border-blue-200 bg-blue-50/40">
          <CardContent className="pt-6 space-y-2">
            <div className="flex items-center gap-3">
              <Loader2 size={18} className="animate-spin text-blue-600" />
              <div className="flex-1">
                <p className="text-sm font-medium text-blue-900">
                  {activeSearch.status === "pending"
                    ? "Queued — waiting for the next worker tick"
                    : activeSearch.progress_message ?? "Running…"}
                </p>
                <p className="text-xs text-blue-700/70">
                  {activeSearch.result_count.toLocaleString()} of up to{" "}
                  {activeSearch.target_max_results.toLocaleString()} results ·{" "}
                  {activeSearch.pages_fetched} pages fetched
                </p>
              </div>
            </div>
            <p className="text-[11px] text-blue-700/60">
              You can close this tab — the search keeps running. Open it again
              from "Recent searches" any time.
            </p>
          </CardContent>
        </Card>
      )}

      {showError && activeSearch && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="flex items-start gap-3 pt-6">
            <AlertTriangle size={18} className="text-red-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-red-700">Search failed</p>
              <p className="text-xs text-red-600/80 mt-1">
                {activeSearch.error_message ?? "Unknown error"}
              </p>
              {activeSearch.result_count > 0 && (
                <p className="text-xs text-red-600/80 mt-1">
                  {activeSearch.result_count.toLocaleString()} results were
                  fetched before the failure (preserved below).
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {(showResults || (showError && activeSearch && activeSearch.results.length > 0)) && activeSearch && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500">
                <MapPin size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Results</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {selected.size} of {activeSearch.results.length} selected
                  {activeSearch.truncated && (
                    <span className="ml-2 text-amber-600">
                      (more available — bump the cap to fetch more)
                    </span>
                  )}
                </p>
              </div>
            </div>
            <Button
              onClick={handleSaveSelected}
              disabled={selected.size === 0}
              variant="outline"
              size="sm"
            >
              Save selected
            </Button>
          </CardHeader>
          <CardContent>
            {activeSearch.results.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No matches. Loosen your filters or try a different category.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={
                          activeSearch.results.length > 0 &&
                          selected.size === activeSearch.results.length
                        }
                        onChange={toggleAll}
                        className="cursor-pointer"
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead>Business</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Reviews</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {activeSearch.results.map((r) => {
                    const key = rowKey(r);
                    return (
                      <TableRow key={key}>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleRow(key)}
                            className="cursor-pointer"
                            aria-label={`Select ${r.name}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col">
                            <span className="font-medium">{r.name || "—"}</span>
                            {r.website && (
                              <a
                                href={r.website}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-[#2E37FE] hover:underline truncate max-w-[280px]"
                              >
                                {r.website}
                              </a>
                            )}
                            {r.is_closed && (
                              <Badge
                                variant="secondary"
                                className="bg-red-50 text-red-700 border border-red-200 mt-1 w-fit text-[10px]"
                              >
                                Closed
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate">
                          {r.email || (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {r.phone || (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col text-xs">
                            <span>{r.city || "—"}</span>
                            <span className="text-muted-foreground">
                              {r.state} {r.postal_code}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.reviews_count ? (
                            <span>
                              <strong>{r.reviews_rating || "—"}</strong>{" "}
                              <span className="text-muted-foreground">
                                ({r.reviews_count})
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SearchStatusIcon({ status }: { status: ProspectSearchStatus }) {
  if (status === "complete")
    return <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />;
  if (status === "running")
    return <Loader2 size={16} className="text-blue-600 animate-spin shrink-0" />;
  if (status === "pending")
    return <Clock size={16} className="text-amber-600 shrink-0" />;
  return <XCircle size={16} className="text-red-600 shrink-0" />;
}
