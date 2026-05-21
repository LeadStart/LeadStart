"use client";

// Paginated list of contacts assigned to this campaign. Fetches via the
// browser supabase client + .range() for server-side pagination so a
// 5000-contact campaign doesn't ship the whole dataset to the browser.
// Status field surfaces 'uploaded' (already pushed to Salesforge), 'new'
// (waiting in the queue or unassigned), 'replied', etc.

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { Loader2, Users } from "lucide-react";
import type { Contact } from "@/types/app";

const PAGE_SIZE = 50;

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

export function CampaignContactsTable({
  campaignId,
}: {
  campaignId: string;
}) {
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      </div>
      <CardContent className="pt-4">
        {error && (
          <p className="text-sm text-red-600">Failed to load: {error}</p>
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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-center py-6">
                        <Loader2
                          size={16}
                          className="inline-block animate-spin text-muted-foreground"
                        />
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((c) => (
                      <TableRow key={c.id}>
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
                            {c.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {c.source || "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground whitespace-nowrap">
                          {new Date(c.created_at).toLocaleDateString()}
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
