"use client";

// Pull EXISTING CRM contacts into a native email campaign (Phase 2 of the
// contact-list ↔ campaign alignment). Sits next to the CSV import panel on the
// campaign's Leads tab. Search/tag-filter the campaign's client's contacts,
// select them, see coverage of the campaign's variables against the selection
// (warn where a used variable has no value + no fallback), and enroll: reusing
// the campaign variable registry from the same bootstrap the CSV panel uses.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Users,
  Search,
  AlertCircle,
  CheckCircle2,
  Loader2,
  UserPlus,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { normalizeVarKey } from "@/lib/native/tokens";

interface CampaignTokens {
  standard: { token: string; key: string; fields: string[]; hasFallback: boolean }[];
  custom: { token: string; key: string; hasFallback: boolean }[];
}

interface Candidate {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company_name: string | null;
  title: string | null;
  phone: string | null;
  tags: string[];
  custom_fields: Record<string, unknown>;
  enrolled: boolean;
}

interface EnrollResult {
  assigned: number;
  enrolled: number;
  already_enrolled: number;
  skipped_undeliverable: number;
  skipped_not_in_client: number;
}

// Which contact property backs each standard token field (for coverage checks).
const STANDARD_FIELD_ACCESSOR: Record<string, (c: Candidate) => string | null> = {
  first_name: (c) => c.first_name,
  last_name: (c) => c.last_name,
  company_name: (c) => c.company_name,
  title: (c) => c.title,
  phone: (c) => c.phone,
  email: (c) => c.email,
  intro_line: () => null, // not returned by the candidate query; treated as absent
};

export function CrmPullPanel({ campaignId }: { campaignId: string }) {
  const [tokens, setTokens] = useState<CampaignTokens | null>(null);
  const [clientAssigned, setClientAssigned] = useState<boolean | null>(null);

  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);

  // Registry/token bootstrap (shared with the CSV panel): for coverage warnings.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(appUrl(`/api/campaigns/${campaignId}/client-import`));
        if (!res.ok) return;
        const data = (await res.json()) as { tokens: CampaignTokens };
        if (!cancelled) setTokens(data.tokens);
      } catch {
        /* coverage is advisory: ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  const search = useCallback(
    async (query: string, tagFilter: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        const qs = new URLSearchParams();
        if (query) qs.set("q", query);
        if (tagFilter) qs.set("tag", tagFilter);
        const res = await fetch(
          appUrl(`/api/campaigns/${campaignId}/candidate-contacts?${qs.toString()}`),
        );
        const data = (await res.json()) as {
          candidates?: Candidate[];
          client_assigned?: boolean;
          error?: string;
        };
        if (!res.ok) {
          setLoadError(data.error ?? `HTTP ${res.status}`);
          return;
        }
        setClientAssigned(data.client_assigned ?? true);
        setCandidates(data.candidates ?? []);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [campaignId],
  );

  // Initial load (recent contacts) once.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    search("", "");
  }, [search]);

  // Selectable = not already enrolled.
  const selectable = useMemo(() => candidates.filter((c) => !c.enrolled), [candidates]);
  const selectedList = useMemo(
    () => candidates.filter((c) => selected.has(c.id)),
    [candidates, selected],
  );

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    setSelected((prev) => {
      const allSelected = selectable.every((c) => prev.has(c.id));
      if (allSelected) return new Set();
      return new Set(selectable.map((c) => c.id));
    });
  }

  // Per-token coverage across the SELECTED contacts: how many have a value for a
  // variable the copy uses (no inline default → will blank if absent).
  const coverage = useMemo(() => {
    if (!tokens || selectedList.length === 0) return [];
    const contactHas = (c: Candidate, key: string, kind: "standard" | "custom", fields: string[]) => {
      if (kind === "standard") {
        return fields.some((f) => (STANDARD_FIELD_ACCESSOR[f]?.(c) ?? "").trim() !== "");
      }
      for (const [k, v] of Object.entries(c.custom_fields)) {
        if (normalizeVarKey(k) === key && v != null && String(v).trim() !== "") return true;
      }
      return false;
    };
    const rows: { token: string; have: number; total: number }[] = [];
    for (const t of tokens.standard) {
      if (t.hasFallback) continue;
      const have = selectedList.filter((c) => contactHas(c, t.key, "standard", t.fields)).length;
      if (have < selectedList.length) rows.push({ token: t.token, have, total: selectedList.length });
    }
    for (const t of tokens.custom) {
      if (t.hasFallback) continue;
      const have = selectedList.filter((c) => contactHas(c, t.key, "custom", [])).length;
      if (have < selectedList.length) rows.push({ token: t.token, have, total: selectedList.length });
    }
    return rows;
  }, [tokens, selectedList]);

  async function enroll() {
    if (selected.size === 0) return;
    setEnrolling(true);
    setEnrollError(null);
    setResult(null);
    try {
      const res = await fetch(appUrl(`/api/campaigns/${campaignId}/enroll-existing`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_ids: [...selected] }),
      });
      const data = (await res.json()) as EnrollResult & { error?: string };
      if (!res.ok) {
        setEnrollError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data);
      setSelected(new Set());
      // Refresh so the just-added contacts flip to the "in campaign" badge.
      search(q, tag);
    } catch (err) {
      setEnrollError(err instanceof Error ? err.message : String(err));
    } finally {
      setEnrolling(false);
    }
  }

  const name = (c: Candidate) =>
    [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";

  if (clientAssigned === false) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-500" />
        <p className="text-sm text-amber-800">
          Assign a client to this campaign to pull existing contacts from the CRM.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/60 p-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Users size={15} /> Add from existing contacts
      </div>
      <p className="text-xs text-muted-foreground">
        Pull already-imported or enriched contacts into this campaign. They keep their
        stored values; anything a variable needs but a contact lacks sends blank (or its{" "}
        <code>{"{{token|default}}"}</code>).
      </p>

      {/* Search + tag */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search(q, tag)}
            placeholder="Search name, email, company…"
            className="w-full rounded-md border border-border/60 bg-background py-1.5 pl-7 pr-2 text-xs"
          />
        </div>
        <input
          type="text"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search(q, tag)}
          placeholder="Filter by tag"
          className="w-36 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs"
        />
        <button
          type="button"
          onClick={() => search(q, tag)}
          disabled={loading}
          className="rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium hover:bg-muted/50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : "Search"}
        </button>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {loadError}
        </div>
      )}

      {/* Results */}
      {candidates.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-border/60">
          <table className="w-full text-xs">
            <thead className="bg-muted/20">
              <tr>
                <th className="w-8 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={selectable.length > 0 && selectable.every((c) => selected.has(c.id))}
                    onChange={toggleAll}
                    disabled={selectable.length === 0}
                  />
                </th>
                <th className="px-2 py-1.5 text-left font-medium">Name</th>
                <th className="px-2 py-1.5 text-left font-medium">Email</th>
                <th className="px-2 py-1.5 text-left font-medium">Company</th>
                <th className="px-2 py-1.5 text-left font-medium">Tags</th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-border/40 ${c.enrolled ? "opacity-60" : "cursor-pointer hover:bg-muted/20"}`}
                  onClick={() => !c.enrolled && toggle(c.id)}
                >
                  <td className="px-2 py-1.5">
                    {c.enrolled ? (
                      <span title="Already in this campaign">
                        <CheckCircle2 size={13} className="text-emerald-500" />
                      </span>
                    ) : (
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Select ${name(c)}`}
                      />
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {name(c)}
                    {c.enrolled && <span className="ml-1 text-[10px] text-emerald-600">in campaign</span>}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px]">{c.email || "—"}</td>
                  <td className="px-2 py-1.5">{c.company_name || "—"}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {c.tags.length > 0 ? c.tags.slice(0, 3).join(", ") : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !loading && (
          <p className="py-2 text-xs text-muted-foreground">
            No contacts found for this client{q || tag ? " with those filters" : ""}.
          </p>
        )
      )}

      {/* Coverage warnings for the selection */}
      {coverage.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          <div className="flex items-start gap-1.5">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">Some selected contacts are missing values the copy uses:</p>
              <ul className="mt-1 space-y-0.5">
                {coverage.map((r) => (
                  <li key={r.token}>
                    <strong>
                      {"{{"}
                      {r.token}
                      {"}}"}
                    </strong>{" "}
                   : {r.have}/{r.total} have a value (the rest send blank).
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {enrollError && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
          <AlertCircle size={12} className="mt-0.5 shrink-0" /> {enrollError}
        </div>
      )}
      {result && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs text-emerald-900">
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-600" />
          <span>
            Added <strong>{result.assigned}</strong> contact{result.assigned === 1 ? "" : "s"} to
            this campaign, <strong>{result.enrolled}</strong> newly enrolled for sending
            {result.already_enrolled > 0 && <> ({result.already_enrolled} already enrolled)</>}
            {result.skipped_undeliverable > 0 && (
              <> · {result.skipped_undeliverable} skipped (verified undeliverable)</>
            )}
            .
          </span>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={enroll}
          disabled={enrolling || selected.size === 0}
          className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          style={{ background: "#2E37FE" }}
        >
          {enrolling ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Adding…
            </>
          ) : (
            <>
              <UserPlus size={13} /> Add {selected.size || ""} contact{selected.size === 1 ? "" : "s"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
