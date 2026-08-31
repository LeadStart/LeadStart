"use client";

// Buyer "run a search" surface (Phase 5). A constrained Google-Maps sourcing
// form that calls the reserve-wrapped buyer route; on success the reserve holds
// worst-case tokens and the existing cron runs + enriches, settling to delivered
// on completion. Below, the buyer's recent searches with live status + delivered.

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { useBuyerData } from "../buyer-data-context";
import { appUrl } from "@/lib/api-url";
import { Loader2, Search as SearchIcon, MapPin } from "lucide-react";

interface Coverage {
  owned: number;
  available: number;
  terms: string[];
  area: string;
}

interface SearchRow {
  id: string;
  kind: string;
  status: string;
  target_max_results: number;
  result_count: number;
  delivered_counts: Record<string, number> | null;
  coverage: Coverage | null;
  created_at: string;
  completed_at: string | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  running: "bg-blue-100 text-blue-700",
  complete: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
};

function delivered(row: SearchRow): number {
  const d = row.delivered_counts;
  if (!d) return 0;
  return ["personal_email", "company_email", "verified_email"].reduce((s, k) => s + Number(d[k] ?? 0), 0);
}

// Master-pool coverage: how many of this segment's contacts the buyer owns, and
// how many more the shared pool holds (the resale hint). "—" until the segment
// has any pooled data (an empty pool, or an unsegmentable search).
function CoverageCell({ row, onResale, busy }: { row: SearchRow; onResale: () => void; busy: boolean }) {
  const c = row.coverage;
  if (!c || c.available === 0) return <span className="text-muted-foreground">—</span>;
  const more = Math.max(0, c.available - c.owned);
  return (
    <span title={`Segment: ${c.terms.join(", ")} · ${c.area}`} className="inline-flex items-center gap-1.5">
      <span>
        <strong className="text-foreground">{c.owned.toLocaleString()}</strong>
        <span className="text-muted-foreground"> of ~{c.available.toLocaleString()}</span>
      </span>
      {more > 0 && (
        <button
          type="button"
          onClick={onResale}
          disabled={busy}
          title="Add the remaining contacts in this segment from the shared pool"
          className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 transition-colors hover:bg-green-200 disabled:opacity-60"
        >
          {busy ? "Adding…" : `Get ${more.toLocaleString()} more`}
        </button>
      )}
    </span>
  );
}

export default function BuyerSearchPage() {
  const { balance } = useBuyerData();
  const [terms, setTerms] = useState("");
  const [location, setLocation] = useState("");
  const [maxResults, setMaxResults] = useState(200);
  const [verify, setVerify] = useState(true);
  const [naming, setNaming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rows, setRows] = useState<SearchRow[] | null>(null);
  const [resaleId, setResaleId] = useState<string | null>(null);

  const loadSearches = useCallback(() => {
    fetch(appUrl("/api/buyer/prospecting/searches"))
      .then((res) => res.json().catch(() => ({})))
      .then((d: { maps?: SearchRow[]; linkedin?: SearchRow[] }) => {
        const all = [...(d.maps ?? []), ...(d.linkedin ?? [])].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        setRows(all);
      })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    loadSearches();
    const t = setInterval(loadSearches, 8000); // poll while searches run
    return () => clearInterval(t);
  }, [loadSearches]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setNotice(null);
    setSubmitting(true);
    try {
      const res = await fetch(appUrl("/api/buyer/prospecting/maps-search"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          search_terms: terms.split(",").map((t) => t.trim()).filter(Boolean),
          location_query: location.trim(),
          max_results: maxResults,
          verify,
          naming,
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; held?: number };
      if (res.ok) {
        setNotice(`Search started — reserved ${d.held ?? 0} tokens. It will appear below and settle to what we deliver.`);
        setTerms("");
        loadSearches();
      } else {
        setNotice(d.error || "Could not start the search.");
      }
    } catch {
      setNotice("Network error. Please try again.");
    }
    setSubmitting(false);
  }

  // Resale: buy the remaining pool contacts in a completed search's segment.
  async function resale(row: SearchRow) {
    setNotice(null);
    setResaleId(row.id);
    try {
      const res = await fetch(appUrl("/api/buyer/prospecting/resale"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ search_id: row.id, kind: row.kind }),
      });
      const d = (await res.json().catch(() => ({}))) as { served?: number; charged?: number; message?: string; error?: string };
      if (res.ok) {
        setNotice(
          d.served && d.served > 0
            ? `Added ${d.served} contacts from the pool — charged ${d.charged ?? 0} tokens.`
            : d.message || "Nothing new to add right now.",
        );
        loadSearches();
      } else {
        setNotice(d.error || "Could not add more contacts.");
      }
    } catch {
      setNotice("Network error. Please try again.");
    }
    setResaleId(null);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Run a search" />

      <form onSubmit={submit} className="rounded-2xl border border-border bg-white p-6 shadow-sm space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <MapPin size={16} /> Google Maps sourcing. Available balance: <strong className="text-foreground">{balance.available.toLocaleString()}</strong> tokens.
        </div>
        <div>
          <label htmlFor="terms" className="mb-1 block text-sm font-medium text-foreground">What businesses? (comma-separated)</label>
          <input id="terms" value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="dentist, orthodontist" required className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
        </div>
        <div>
          <label htmlFor="loc" className="mb-1 block text-sm font-medium text-foreground">Where?</label>
          <input id="loc" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Dallas, TX" required className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="max" className="mb-1 block text-sm font-medium text-foreground">Max results</label>
            <input id="max" type="number" min={1} max={2000} value={maxResults} onChange={(e) => setMaxResults(Math.max(1, Math.min(2000, Number(e.target.value) || 1)))} className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" />
          </div>
          <div className="flex items-end gap-4 pb-1">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} /> Verify emails</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={naming} onChange={(e) => setNaming(e.target.checked)} /> Find owner names</label>
          </div>
        </div>
        {notice && <p className="text-sm text-foreground">{notice}</p>}
        <button type="submit" disabled={submitting} className="flex items-center justify-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60">
          {submitting ? <Loader2 size={16} className="animate-spin" /> : <SearchIcon size={16} />} Start search
        </button>
      </form>

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold text-foreground">Recent searches</p>
        {rows === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No searches yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4">Vein</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Found</th><th className="py-2 pr-4">Emails delivered</th><th className="py-2 pr-4">You own</th><th className="py-2">Started</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border/60">
                    <td className="py-2 pr-4 capitalize">{r.kind}</td>
                    <td className="py-2 pr-4"><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? "bg-muted text-muted-foreground"}`}>{r.status}</span></td>
                    <td className="py-2 pr-4">{r.result_count}</td>
                    <td className="py-2 pr-4">{delivered(r)}</td>
                    <td className="py-2 pr-4"><CoverageCell row={r} onResale={() => resale(r)} busy={resaleId === r.id} /></td>
                    <td className="py-2 text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
