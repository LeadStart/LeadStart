"use client";

// Buyer "My contacts" surface — the RESULTS a buyer paid for. Lists their sourced
// contacts (their org) 25/page with a search filter, and a one-click CSV download
// of the full set. Data comes from the service-role /api/buyer/contacts route
// (contacts RLS is owner/va-only), so a buyer only ever sees their own org.

import { useEffect, useState, useCallback } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { appUrl } from "@/lib/api-url";
import { Loader2, Download, Search as SearchIcon, ChevronLeft, ChevronRight, CheckCircle2 } from "lucide-react";

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  title: string | null;
  company_name: string | null;
  company_email: string | null;
  phone: string | null;
  company_phone: string | null;
  email_verification_status: string | null;
  created_at: string;
}

const PAGE_SIZE = 25;

function fullName(c: ContactRow): string {
  return [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
}

export default function BuyerContactsPage() {
  const [rows, setRows] = useState<ContactRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [queryInput, setQueryInput] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback((p: number, search: string) => {
    const params = new URLSearchParams({ page: String(p) });
    if (search) params.set("q", search);
    fetch(appUrl(`/api/buyer/contacts?${params.toString()}`))
      .then((r) => r.json().catch(() => ({})))
      .then((d: { contacts?: ContactRow[]; total?: number }) => {
        setRows(d.contacts ?? []);
        setTotal(d.total ?? 0);
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(page, q);
  }, [load, page, q]);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setPage(1);
    setQ(queryInput.trim());
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="My contacts" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={submitSearch} className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              placeholder="Search name, company, email"
              className="w-64 rounded-lg border border-border py-2 pl-9 pr-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted">Search</button>
          {q && (
            <button type="button" onClick={() => { setQueryInput(""); setQ(""); setPage(1); }} className="text-sm text-muted-foreground hover:text-foreground">Clear</button>
          )}
        </form>
        <a
          href={appUrl("/api/buyer/contacts/export")}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          <Download size={15} /> Download CSV
        </a>
      </div>

      <div className="rounded-2xl border border-border bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total.toLocaleString()} contact{total === 1 ? "" : "s"}
          </p>
          {loading && <Loader2 size={15} className="animate-spin text-muted-foreground" />}
        </div>

        {rows === null ? (
          <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {q ? "No contacts match your search." : "No contacts yet. Run a search to start sourcing."}
          </p>
        ) : (
          <>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-4">Name</th>
                    <th className="py-2 pr-4">Company</th>
                    <th className="py-2 pr-4">Title</th>
                    <th className="py-2 pr-4">Email</th>
                    <th className="py-2 pr-4">Phone</th>
                    <th className="py-2">Sourced</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id} className="border-t border-border/60 align-top">
                      <td className="py-2 pr-4 font-medium">{fullName(c)}</td>
                      <td className="py-2 pr-4">{c.company_name ?? "—"}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{c.title ?? "—"}</td>
                      <td className="py-2 pr-4">
                        {c.email ? (
                          <span className="inline-flex items-center gap-1">
                            {c.email}
                            {c.email_verification_status === "ok" && <CheckCircle2 size={13} className="text-green-600" />}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{c.company_email ?? "—"}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">{c.phone ?? c.company_phone ?? "—"}</td>
                      <td className="py-2 text-muted-foreground">{new Date(c.created_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between">
                <button
                  disabled={page <= 1 || loading}
                  onClick={() => { setLoading(true); setPage((p) => Math.max(1, p - 1)); }}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  <ChevronLeft size={15} /> Prev
                </button>
                <span className="text-sm text-muted-foreground">Page {page} of {totalPages}</span>
                <button
                  disabled={page >= totalPages || loading}
                  onClick={() => { setLoading(true); setPage((p) => Math.min(totalPages, p + 1)); }}
                  className="flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  Next <ChevronRight size={15} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
