"use client";

import { useEffect, useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { ADMIN_FEEDBACK_KEY, fetchAdminFeedback } from "@/lib/admin-queries";
import { useSort } from "@/hooks/use-sort";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { StatCard } from "@/components/charts/stat-card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { MessageSquare, ThumbsUp, ThumbsDown } from "lucide-react";

const FEEDBACK_PAGE_SIZE = 25;

export default function FeedbackPage() {
  const { data, loading } = useSupabaseQuery(
    ADMIN_FEEDBACK_KEY,
    fetchAdminFeedback,
  );

  const { feedback, campaigns } = data || { feedback: [], campaigns: [] };
  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));
  const rows = feedback.map(f => ({
    ...f,
    campaignName: campaignMap.get(f.campaign_id) || ""
  }));
  const { sorted, sortConfig, requestSort } = useSort(rows);
  const total = feedback.length;

  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [sortConfig?.key, sortConfig?.direction]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / FEEDBACK_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * FEEDBACK_PAGE_SIZE;
  const pageRows = sorted.slice(pageStart, pageStart + FEEDBACK_PAGE_SIZE);
  const good = feedback.filter((f) => ["good_lead", "interested"].includes(f.status)).length;
  const bad = feedback.filter((f) => ["bad_lead", "wrong_person", "not_interested"].includes(f.status)).length;

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a]" style={{ background: '#EDEEFF', border: '1px solid #e2e8f0', borderTop: '1px solid #e2e8f0', boxShadow: 'none' }}>
        <div className="relative z-10"><p className="text-xs font-medium text-[#64748b]">Client Submissions</p><h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Lead Feedback</h1><p className="text-sm text-[#0f172a]/60 mt-1">{total} total submissions from clients</p></div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-transparent" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Feedback" value={total} icon={<MessageSquare size={18} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
        <StatCard label="Positive" value={good} icon={<ThumbsUp size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Negative" value={bad} icon={<ThumbsDown size={18} className="text-red-500" />} iconBg="bg-red-50" valueColor="text-red-600" />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><MessageSquare size={16} className="text-white" /></div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">All Feedback</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {feedback.length === 0 ? <p className="text-sm text-muted-foreground">No feedback yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="lead_email" sortConfig={sortConfig} onSort={requestSort}>Lead</SortableHead><SortableHead sortKey="campaignName" sortConfig={sortConfig} onSort={requestSort}>Campaign</SortableHead><SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead><SortableHead sortKey="comment" sortConfig={sortConfig} onSort={requestSort}>Comment</SortableHead><SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>Date</SortableHead></TableRow></TableHeader>
              <TableBody>
                {pageRows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell><p className="font-medium">{f.lead_email}</p>{f.lead_company && <p className="text-xs text-muted-foreground">{f.lead_company}</p>}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{campaignMap.get(f.campaign_id) || "—"}</TableCell>
                    <TableCell><Badge variant="secondary" className={["good_lead", "interested"].includes(f.status) ? "badge-green" : ["bad_lead", "wrong_person", "not_interested"].includes(f.status) ? "badge-red" : "badge-slate"}>{f.status.replace(/_/g, " ")}</Badge></TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-muted-foreground">{f.comment || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <PaginationControls
            currentPage={safePage}
            totalItems={sorted.length}
            pageSize={FEEDBACK_PAGE_SIZE}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
