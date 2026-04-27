"use client";

import { useState } from "react";
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
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { ScrapioBusiness } from "@/types/app";
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

const MAX_RESULTS_OPTIONS = [100, 250, 500, 1000] as const;
const HARD_RESULT_CAP = 1000;

type ResultMeta = {
  search_id: string | null;
  count: number;
  pages: number;
  total_available: number | null;
  truncated: boolean;
};

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

export default function ProspectingPage() {
  const [categoryInput, setCategoryInput] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<TypeaheadResult | null>(
    null,
  );

  const [locationInput, setLocationInput] = useState("");
  const [selectedLocation, setSelectedLocation] = useState<TypeaheadResult | null>(
    null,
  );

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [maxResults, setMaxResults] = useState<number>(100);

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [results, setResults] = useState<ScrapioBusiness[] | null>(null);
  const [resultMeta, setResultMeta] = useState<ResultMeta | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  function handleCategorySelect(item: TypeaheadResult) {
    setSelectedCategory(item);
    setCategoryInput(item.text);
  }

  function handleLocationSelect(item: TypeaheadResult) {
    setSelectedLocation(item);
    setLocationInput(item.text);
  }

  function clearCategory() {
    setSelectedCategory(null);
    setCategoryInput("");
  }

  function clearLocation() {
    setSelectedLocation(null);
    setLocationInput("");
  }

  async function handleSearch() {
    if (!selectedCategory) {
      setSearchError("Pick a category from the dropdown first.");
      return;
    }
    if (!selectedLocation) {
      setSearchError("Pick a location (state, county, or city) from the dropdown first.");
      return;
    }
    setSearching(true);
    setSearchError(null);
    setSelected(new Set());

    const body: Record<string, unknown> = {
      type: selectedCategory.id,
      max_results: maxResults,
      filters,
    };
    if (selectedLocation.search_type === "admin1") {
      body.admin1_code = selectedLocation.id;
    } else if (selectedLocation.search_type === "admin2") {
      // Server requires admin1_code alongside admin2_code.
      body.admin1_code = selectedLocation.parent_admin1;
      body.admin2_code = selectedLocation.id;
    } else if (selectedLocation.search_type === "city") {
      // Use the city portion of "Austin, TX" — Scrap.io's city param is a
      // free-text name, not the gmap location id.
      const cityName = selectedLocation.text.split(",")[0].trim();
      body.admin1_code = selectedLocation.parent_admin1;
      body.city = cityName;
    } else {
      setSearchError("Selected location is missing a type. Pick again.");
      setSearching(false);
      return;
    }

    try {
      const res = await fetch(appUrl("/api/admin/prospecting/search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error ?? "Search failed");
        setResults(null);
        setResultMeta(null);
      } else {
        setResults(data.results ?? []);
        setResultMeta({
          search_id: data.search_id ?? null,
          count: data.count ?? 0,
          pages: data.pages ?? 0,
          total_available: data.total_available ?? null,
          truncated: !!data.truncated,
        });
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
      setResultMeta(null);
    } finally {
      setSearching(false);
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
    if (!results) return;
    setSelected((prev) => {
      if (prev.size === results.length) return new Set();
      return new Set(results.map(rowKey));
    });
  }

  function handleSaveSelected() {
    alert(
      `Save flow lands in Phase 3.\nSelected ${selected.size} of ${results?.length ?? 0}.`,
    );
  }

  const locationBadge =
    selectedLocation?.search_type
      ? LOCATION_BADGES[selectedLocation.search_type]
      : null;

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
            into your CRM pipeline.
          </p>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Search form */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <Search size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">New search</CardTitle>
            <p className="text-xs text-muted-foreground">
              Burns Scrap.io credits on Search — capped at {HARD_RESULT_CAP} results
              per run.
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
                onSelect={handleCategorySelect}
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
                onSelect={handleLocationSelect}
                onSearch={searchLocations}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              Pick a State to search the whole state, a County to narrow to one,
              or a City for hyper-local results.
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
                  {n}
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
                  className="w-24 h-8"
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Hard cap is {HARD_RESULT_CAP} per search to keep credit burn predictable.
              Each ~100 results = roughly one Scrap.io API call.
            </p>
          </div>

          {/* Search button */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={handleSearch}
              disabled={searching}
              style={{ background: "#2E37FE" }}
            >
              {searching ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-2" /> Searching…
                </>
              ) : (
                <>
                  <Search size={14} className="mr-2" /> Search up to {maxResults}
                </>
              )}
            </Button>
            {resultMeta && (
              <span className="text-xs text-muted-foreground">
                Last run: {resultMeta.count} results across {resultMeta.pages}{" "}
                page{resultMeta.pages === 1 ? "" : "s"}
                {resultMeta.total_available !== null && (
                  <> · {resultMeta.total_available} available</>
                )}
                {resultMeta.truncated && (
                  <span className="ml-2 text-amber-600">(truncated to cap)</span>
                )}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Error */}
      {searchError && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="flex items-center gap-3 pt-6">
            <AlertTriangle size={18} className="text-red-500 shrink-0" />
            <span className="text-sm text-red-700">{searchError}</span>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {results && (
        <Card className="border-border/50 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500">
                <MapPin size={16} className="text-white" />
              </div>
              <div>
                <CardTitle className="text-base">Results</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {selected.size} of {results.length} selected
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
            {results.length === 0 ? (
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
                          results.length > 0 &&
                          selected.size === results.length
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
                  {results.map((r) => {
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
