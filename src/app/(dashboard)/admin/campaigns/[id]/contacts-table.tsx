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

import { useCallback, useEffect, useState } from "react";
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
import { Loader2, Users, X, Info, RefreshCw } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import type { Contact, CampaignStatus } from "@/types/app";

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
  "id, email, first_name, last_name, company_name, title, status, source, created_at, updated_at";

type ContactRow = Pick<
  Contact,
  | "id"
  | "email"
  | "first_name"
  | "last_name"
  | "company_name"
  | "title"
  | "status"
  | "source"
  | "created_at"
  | "updated_at"
>;

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

// One-liner explaining the sequence state so the user understands
// whether emails are actively being sent.
function sequenceStatusNote(status: CampaignStatus): {
  label: string;
  detail: string;
  tone: "amber" | "emerald" | "slate";
} {
  switch (status) {
    case "active":
      return {
        label: "Sequence is active",
        detail:
          "Salesforge is sending to these contacts at the per-campaign daily cap. Newly added contacts start at step 1.",
        tone: "emerald",
      };
    case "paused":
      return {
        label: "Sequence is paused",
        detail:
          "No emails are going out. Resume the sequence in app.salesforge.ai to start sending again.",
        tone: "amber",
      };
    case "completed":
      return {
        label: "Sequence completed",
        detail:
          "All steps have been delivered. Contacts here are historical.",
        tone: "slate",
      };
    case "draft":
    default:
      return {
        label: "Sequence is in draft — not sending yet",
        detail:
          "These contacts are assigned to the sequence but Salesforge will only start emailing them once you flip the sequence to active in app.salesforge.ai.",
        tone: "amber",
      };
  }
}

export function CampaignContactsTable({
  campaignId,
  campaignStatus,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
}) {
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

  const fetchPage = useCallback(
    async (pageNum: number) => {
      setLoading(true);
      setError(null);
      const supabase = createClient();
      const from = (pageNum - 1) * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, count, error: queryErr } = await supabase
        .from("contacts")
        .select(CONTACT_COLUMNS, { count: "exact" })
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .range(from, to);
      if (queryErr) {
        setError(queryErr.message);
        setRows([]);
        setTotal(0);
      } else {
        setRows((data ?? []) as unknown as ContactRow[]);
        setTotal(count ?? 0);
      }
      setLoading(false);
    },
    [campaignId],
  );

  useEffect(() => {
    fetchPage(page);
  }, [page, fetchPage]);

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
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemovingId(null);
    }
  }

  const note = sequenceStatusNote(campaignStatus);
  const noteToneClasses =
    note.tone === "emerald"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
      : note.tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-900"
        : "border-border/60 bg-muted/30 text-foreground";

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
        <div
          className={`flex items-start gap-2 rounded-md border px-3 py-2 ${noteToneClasses}`}
        >
          <Info size={14} className="mt-0.5 shrink-0" />
          <div className="text-xs">
            <p className="font-medium">{note.label}</p>
            <p className="opacity-80 mt-0.5">{note.detail}</p>
          </div>
        </div>

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
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Title</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="text-right">Added</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-6">
                        <Loader2
                          size={16}
                          className="inline-block animate-spin text-muted-foreground"
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((c) => (
                      <TableRow key={c.id} className="group">
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
                    ))
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
