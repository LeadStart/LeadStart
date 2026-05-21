"use client";

// Paginated list of contacts assigned to this campaign. Fetches via the
// browser supabase client + .range() for server-side pagination so a
// 5000-contact campaign doesn't ship the whole dataset to the browser.
//
// Two interaction surfaces on top of the table:
//   - "Sequence status" banner showing the parent campaign's status as a
//     proxy for "have these contacts started receiving emails?" Salesforge
//     legacy has no per-contact step-progress API, so all contacts on a
//     sequence share the sequence's state.
//   - Per-row Remove button that calls /api/admin/campaigns/[id]/unlink-contact
//     (LeadStart-side only — Salesforge legacy has no unenroll endpoint;
//     stopping the upstream send requires pausing the sequence in
//     app.salesforge.ai or adding the email to DNC.)

import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Loader2,
  Users,
  X,
  Info,
  RefreshCw,
  ArrowRight,
  Trash2,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { Contact } from "@/types/app";

interface RefreshResult {
  workspace_total: number;
  in_sequence_total: number;
  inserted: number;
  updated: number;
  linked_to_campaign: number;
  unlinked_not_in_sequence: number;
}

const PAGE_SIZE = 25;

const CONTACT_COLUMNS =
  "id, email, first_name, last_name, company_name, title, linkedin_url, phone, tags, notes, status, source, created_at, updated_at";

type ContactRow = Pick<
  Contact,
  | "id"
  | "email"
  | "first_name"
  | "last_name"
  | "company_name"
  | "title"
  | "linkedin_url"
  | "phone"
  | "tags"
  | "notes"
  | "status"
  | "source"
  | "created_at"
  | "updated_at"
>;

// Pull the human-readable handle out of a LinkedIn URL so the column
// shows "@john-doe" rather than the full https://… string. Falls back
// to the raw URL if the path doesn't match the expected /in/<handle>
// shape.
function linkedinHandle(url: string): string {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  return m ? `@${m[1]}` : url;
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "uploaded":
      return "badge-green";
    case "replied":
      return "badge-green";
    case "queued":
      return "badge-amber";
    case "bounced":
      return "badge-red";
    case "unsubscribed":
      return "badge-red";
    case "active":
      return "badge-blue";
    case "enriched":
      return "badge-blue";
    case "new":
    default:
      return "badge-slate";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "queued — pending send";
    default:
      return status;
  }
}

// Status lifecycle reference rendered above the table. Keeps the
// progression (queued → uploaded → active → terminal) visible so the
// operator doesn't have to remember what each badge color means.
const LIFECYCLE_STAGES: {
  status: string;
  hint: string;
}[] = [
  { status: "queued", hint: "in our DB, not yet pushed to Salesforge" },
  { status: "uploaded", hint: "pushed to Salesforge workspace + sequence" },
  { status: "active", hint: "sequence actively sending to this contact" },
];

const LIFECYCLE_TERMINAL: {
  status: string;
  hint: string;
}[] = [
  { status: "replied", hint: "inbound reply received" },
  { status: "bounced", hint: "hard bounce — undeliverable" },
  { status: "unsubscribed", hint: "opted out / on DNC list" },
];

function StatusLegend() {
  return (
    <div className="rounded-md border border-border/60 bg-muted/20 px-3 py-2.5 text-xs">
      <p className="font-medium text-foreground mb-2">Status lifecycle</p>
      <div className="flex flex-wrap items-center gap-2">
        {LIFECYCLE_STAGES.map((stage, i) => (
          <span key={stage.status} className="inline-flex items-center gap-2">
            <span className="inline-flex flex-col items-start gap-0.5">
              <Badge
                variant="secondary"
                className={`${statusBadgeClass(stage.status)} text-[10px]`}
              >
                {statusLabel(stage.status)}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {stage.hint}
              </span>
            </span>
            {i < LIFECYCLE_STAGES.length - 1 && (
              <ArrowRight
                size={12}
                className="text-muted-foreground shrink-0 mt-0.5"
              />
            )}
          </span>
        ))}
      </div>
      <div className="mt-2.5 pt-2 border-t border-border/40">
        <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wide">
          Terminal states
        </p>
        <div className="flex flex-wrap items-start gap-3">
          {LIFECYCLE_TERMINAL.map((s) => (
            <span
              key={s.status}
              className="inline-flex flex-col items-start gap-0.5"
            >
              <Badge
                variant="secondary"
                className={`${statusBadgeClass(s.status)} text-[10px]`}
              >
                {s.status}
              </Badge>
              <span className="text-[10px] text-muted-foreground">
                {s.hint}
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CampaignContactsTable({
  campaignId,
}: {
  campaignId: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<RefreshResult | null>(null);
  // Per-row bulk-select state. Keys are contact ids. Persists across
  // page changes so the operator can build up a selection by paging
  // through, or use "Select all N queued in this campaign" in one click.
  // Visual confirmation comes from the count shown in the action bar.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Total count of contacts that are eligible for bulk-delete on this
  // campaign — i.e. status='queued'. Drives the "Select all N queued"
  // affordance.
  const [queuedTotalCount, setQueuedTotalCount] = useState(0);
  const [selectingAll, setSelectingAll] = useState(false);
  // Whether to render each optional column. Set once on mount via a
  // campaign-wide presence check so columns don't flicker as the operator
  // pages through. Columns appear only when at least one contact has
  // data in that field.
  const [optionalCols, setOptionalCols] = useState({
    linkedin: false,
    phone: false,
    tags: false,
    notes: false,
  });

  const fetchPage = useCallback(
    async (pageNum: number) => {
      setLoading(true);
      setError(null);
      const supabase = createClient();
      const from = (pageNum - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const [pageRes, queuedCountRes] = await Promise.all([
        supabase
          .from("contacts")
          .select(CONTACT_COLUMNS, { count: "exact" })
          .eq("campaign_id", campaignId)
          .order("created_at", { ascending: false })
          .range(from, to),
        // Source of truth for "scheduled to be sent on this campaign" is
        // status='queued' alone. salesforge_contact_id may be populated
        // by sync-analytics from prior workspace presence and is not a
        // signal that this campaign has dispatched the contact yet —
        // only status='uploaded' (set by the dispatcher) means that.
        supabase
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaignId)
          .eq("status", "queued"),
      ]);
      if (pageRes.error) {
        setError(pageRes.error.message);
        setRows([]);
        setTotal(0);
      } else {
        setRows((pageRes.data ?? []) as unknown as ContactRow[]);
        setTotal(pageRes.count ?? 0);
      }
      setQueuedTotalCount(queuedCountRes.count ?? 0);
      setLoading(false);
    },
    [campaignId],
  );

  useEffect(() => {
    fetchPage(page);
  }, [page, fetchPage]);

  // One-shot presence check per campaign — decides which optional columns
  // to render. Cheap (HEAD count queries that hit existing indexes).
  // tags->0 trick: returns the first array element or NULL if empty/null,
  // so `not is null` filters to "tags is non-empty array".
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    Promise.all([
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .not("linkedin_url", "is", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .not("phone", "is", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .not("tags->0", "is", null),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("campaign_id", campaignId)
        .not("notes", "is", null),
    ]).then(([linkedin, phone, tags, notes]) => {
      if (cancelled) return;
      setOptionalCols({
        linkedin: (linkedin.count ?? 0) > 0,
        phone: (phone.count ?? 0) > 0,
        tags: (tags.count ?? 0) > 0,
        notes: (notes.count ?? 0) > 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  // IDs of QUEUED rows on the current page — non-queued rows can't be
  // bulk-deleted (the API filters them out anyway, but disabling the
  // checkbox is clearer to the operator).
  const queuedIdsOnPage = useMemo(
    () => rows.filter((r) => r.status === "queued").map((r) => r.id),
    [rows],
  );
  const selectedOnPageCount = useMemo(
    () => queuedIdsOnPage.filter((id) => selectedIds.has(id)).length,
    [queuedIdsOnPage, selectedIds],
  );
  const allQueuedOnPageSelected =
    queuedIdsOnPage.length > 0 &&
    selectedOnPageCount === queuedIdsOnPage.length;
  const someQueuedOnPageSelected =
    selectedOnPageCount > 0 && !allQueuedOnPageSelected;

  function toggleSelectAllOnPage() {
    const next = new Set(selectedIds);
    if (allQueuedOnPageSelected) {
      queuedIdsOnPage.forEach((id) => next.delete(id));
    } else {
      queuedIdsOnPage.forEach((id) => next.add(id));
    }
    setSelectedIds(next);
  }

  function toggleSelectOne(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }

  async function handleSelectAllQueued() {
    setSelectingAll(true);
    setBulkError(null);
    try {
      const supabase = createClient();
      const { data, error: selectErr } = await supabase
        .from("contacts")
        .select("id")
        .eq("campaign_id", campaignId)
        .eq("status", "queued");
      if (selectErr) {
        setBulkError(`Failed to load all queued: ${selectErr.message}`);
        return;
      }
      const ids = (data ?? []).map((r) => (r as { id: string }).id);
      setSelectedIds(new Set(ids));
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setSelectingAll(false);
    }
  }

  async function handleBulkDelete() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    if (
      !confirm(
        `Delete ${ids.length.toLocaleString()} selected queued contact${
          ids.length === 1 ? "" : "s"
        } from this campaign?\n\n` +
          `These contacts have NOT yet been pushed to Salesforge. ` +
          `Deleting removes them from LeadStart entirely (contact row + queue row). ` +
          `Re-import via CSV if you change your mind.`,
      )
    ) {
      return;
    }
    setBulkDeleting(true);
    setBulkError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/purge-queued`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_ids: ids }),
        },
      );
      const data = (await res.json()) as {
        ok?: boolean;
        deleted?: number;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        setBulkError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setSelectedIds(new Set());
      await fetchPage(page);
      // Re-render the server components above (Enrollment queue card)
      // so the Pending count + "Clear queued (N)" button drop to match.
      startTransition(() => router.refresh());
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : String(err));
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshResult(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/refresh-contacts`),
        { method: "POST" },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string } & RefreshResult;
      if (!res.ok || !data.ok) {
        setRefreshError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      setRefreshResult({
        workspace_total: data.workspace_total,
        in_sequence_total: data.in_sequence_total,
        inserted: data.inserted,
        updated: data.updated,
        linked_to_campaign: data.linked_to_campaign,
        unlinked_not_in_sequence: data.unlinked_not_in_sequence,
      });
      // Jump back to page 1 in case auto-link added new rows; refetch.
      if (page !== 1) setPage(1);
      else await fetchPage(1);
      // Queue card numbers can shift after refresh (newly linked or
      // unlinked-not-in-sequence contacts) — re-render the server side.
      startTransition(() => router.refresh());
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRemove(contactId: string, email: string) {
    if (
      !confirm(
        `Remove ${email} from this campaign?\n\nThis only unlinks them in LeadStart. To stop Salesforge from sending, pause the sequence in app.salesforge.ai or add the email to DNC.`,
      )
    ) {
      return;
    }
    setRemovingId(contactId);
    setRemoveError(null);
    try {
      const res = await fetch(
        appUrl(`/api/admin/campaigns/${campaignId}/unlink-contact`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: contactId }),
        },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setRemoveError(data.error ?? `Failed (HTTP ${res.status})`);
        return;
      }
      // Optimistically drop the row + refetch the current page so totals
      // and pagination stay accurate.
      await fetchPage(page);
      // Also re-render the queue card — unlinking a pending contact
      // also cancels its pending queue row (see unlink-contact route).
      startTransition(() => router.refresh());
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <div className="flex items-center gap-2 px-5 pt-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <Users size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold leading-none">
            Contacts on this campaign
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            {loading
              ? "Loading…"
              : `${total.toLocaleString()} linked${
                  total > PAGE_SIZE
                    ? ` · showing ${PAGE_SIZE} per page`
                    : ""
                }`}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Pull the latest from Salesforge: refresh statuses, add new workspace contacts, and unlink any that have been removed in Salesforge."
        >
          {refreshing ? (
            <>
              <Loader2 size={14} className="mr-1 animate-spin" /> Refreshing…
            </>
          ) : (
            <>
              <RefreshCw size={14} className="mr-1" /> Refresh
            </>
          )}
        </Button>
      </div>
      <CardContent className="pt-4 space-y-3">
        {refreshError && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
            <Info size={14} className="mt-0.5 shrink-0" />
            <p>Refresh failed: {refreshError}</p>
          </div>
        )}
        {refreshResult && (
          <div className="flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            <Info size={14} className="mt-0.5 shrink-0" />
            <p>
              Salesforge says <strong>{refreshResult.in_sequence_total}</strong>{" "}
              contact{refreshResult.in_sequence_total === 1 ? "" : "s"} enrolled
              in this sequence ({refreshResult.workspace_total} total in
              workspace). {refreshResult.inserted} new contact rows,{" "}
              {refreshResult.updated} updated
              {refreshResult.linked_to_campaign > 0 && (
                <>, {refreshResult.linked_to_campaign} linked to this campaign</>
              )}
              {refreshResult.unlinked_not_in_sequence > 0 && (
                <>
                  ,{" "}
                  <strong>
                    {refreshResult.unlinked_not_in_sequence}
                  </strong>{" "}
                  unlinked (removed from Salesforge sequence)
                </>
              )}
              .
            </p>
          </div>
        )}
        <StatusLegend />

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2.5">
            <div className="text-sm text-red-900">
              <strong>{selectedIds.size.toLocaleString()}</strong> queued
              contact{selectedIds.size === 1 ? "" : "s"} selected for delete
              {selectedIds.size < queuedTotalCount && (
                <>
                  {" — "}
                  <button
                    type="button"
                    onClick={handleSelectAllQueued}
                    disabled={selectingAll || bulkDeleting}
                    className="underline underline-offset-2 font-medium hover:text-red-950 disabled:opacity-60 disabled:no-underline"
                  >
                    {selectingAll
                      ? "Selecting…"
                      : `Select all ${queuedTotalCount.toLocaleString()} queued in this campaign`}
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedIds(new Set())}
                disabled={bulkDeleting}
                className="text-red-700 hover:bg-red-100 hover:text-red-800"
              >
                Clear selection
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="border-red-300 text-red-700 hover:bg-red-100 hover:text-red-800"
              >
                {bulkDeleting ? (
                  <>
                    <Loader2 size={14} className="mr-1 animate-spin" /> Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 size={14} className="mr-1" /> Delete selected
                  </>
                )}
              </Button>
            </div>
            {bulkError && (
              <p className="basis-full text-xs text-red-700">{bulkError}</p>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600">Failed to load: {error}</p>
        )}
        {removeError && (
          <p className="text-sm text-red-600">Remove failed: {removeError}</p>
        )}
        {!error && total === 0 && !loading && (
          <p className="text-sm text-muted-foreground py-6 text-center">
            No contacts linked yet. Use the import panel above to add some.
          </p>
        )}
        {!error && (total > 0 || loading) && (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[36px]">
                      <input
                        type="checkbox"
                        className="h-4 w-4 cursor-pointer rounded border-border accent-red-600 disabled:cursor-not-allowed disabled:opacity-40"
                        checked={allQueuedOnPageSelected}
                        ref={(el) => {
                          if (el)
                            el.indeterminate = someQueuedOnPageSelected;
                        }}
                        onChange={toggleSelectAllOnPage}
                        disabled={queuedIdsOnPage.length === 0}
                        aria-label="Select all queued contacts on this page"
                        title={
                          queuedIdsOnPage.length === 0
                            ? "No queued contacts on this page"
                            : "Select all queued on this page"
                        }
                      />
                    </TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Title</TableHead>
                    {optionalCols.linkedin && <TableHead>LinkedIn</TableHead>}
                    {optionalCols.phone && <TableHead>Phone</TableHead>}
                    {optionalCols.tags && <TableHead>Tags</TableHead>}
                    {optionalCols.notes && <TableHead>Notes</TableHead>}
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell
                        colSpan={
                          9 +
                          (optionalCols.linkedin ? 1 : 0) +
                          (optionalCols.phone ? 1 : 0) +
                          (optionalCols.tags ? 1 : 0) +
                          (optionalCols.notes ? 1 : 0)
                        }
                        className="text-center py-6"
                      >
                        <Loader2
                          size={16}
                          className="inline-block animate-spin text-muted-foreground"
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((c) => {
                      const isQueued = c.status === "queued";
                      const isSelected = selectedIds.has(c.id);
                      return (
                      <TableRow
                        key={c.id}
                        className={`group ${
                          isSelected ? "bg-red-50/40" : ""
                        }`}
                      >
                        <TableCell>
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer rounded border-border accent-red-600 disabled:cursor-not-allowed disabled:opacity-30"
                            checked={isSelected}
                            onChange={() => toggleSelectOne(c.id)}
                            disabled={!isQueued}
                            aria-label={
                              isQueued
                                ? `Select ${c.email ?? c.id}`
                                : "Only queued contacts can be bulk-deleted"
                            }
                            title={
                              isQueued
                                ? "Select for bulk delete"
                                : "Only queued contacts can be bulk-deleted"
                            }
                          />
                        </TableCell>
                        <TableCell className="font-mono text-[11px]">
                          {c.email}
                        </TableCell>
                        <TableCell className="text-sm">
                          {[c.first_name, c.last_name]
                            .filter(Boolean)
                            .join(" ") || "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.company_name || "—"}
                        </TableCell>
                        <TableCell className="text-sm">
                          {c.title || "—"}
                        </TableCell>
                        {optionalCols.linkedin && (
                          <TableCell className="text-xs">
                            {c.linkedin_url ? (
                              <a
                                href={c.linkedin_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[#2E37FE] hover:underline font-mono"
                                title={c.linkedin_url}
                              >
                                {linkedinHandle(c.linkedin_url)}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                        {optionalCols.phone && (
                          <TableCell className="text-xs">
                            {c.phone ? (
                              <a
                                href={`tel:${c.phone}`}
                                className="text-[#2E37FE] hover:underline font-mono"
                              >
                                {c.phone}
                              </a>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                        {optionalCols.tags && (
                          <TableCell>
                            {Array.isArray(c.tags) && c.tags.length > 0 ? (
                              <div className="flex flex-wrap gap-1 max-w-[200px]">
                                {c.tags.slice(0, 3).map((t) => (
                                  <Badge
                                    key={t}
                                    variant="secondary"
                                    className="badge-slate text-[10px]"
                                  >
                                    {t}
                                  </Badge>
                                ))}
                                {c.tags.length > 3 && (
                                  <span
                                    className="text-[10px] text-muted-foreground self-center"
                                    title={c.tags.slice(3).join(", ")}
                                  >
                                    +{c.tags.length - 3}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground text-xs">
                                —
                              </span>
                            )}
                          </TableCell>
                        )}
                        {optionalCols.notes && (
                          <TableCell
                            className="text-xs text-muted-foreground max-w-[240px] truncate"
                            title={c.notes ?? undefined}
                          >
                            {c.notes || "—"}
                          </TableCell>
                        )}
                        <TableCell>
                          <Badge
                            variant="secondary"
                            className={statusBadgeClass(c.status)}
                          >
                            {statusLabel(c.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.source || "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(c.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                            disabled={removingId === c.id}
                            onClick={() =>
                              handleRemove(c.id, c.email ?? c.id)
                            }
                            aria-label="Remove from campaign"
                            title="Remove from campaign (LeadStart only)"
                          >
                            {removingId === c.id ? (
                              <Loader2
                                size={12}
                                className="animate-spin"
                              />
                            ) : (
                              <X size={12} />
                            )}
                          </Button>
                        </TableCell>
                      </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </div>
            <PaginationControls
              currentPage={page}
              totalItems={total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
