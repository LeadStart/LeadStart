"use client";

import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SortableHead } from "@/components/ui/sortable-head";
import { StatCard } from "@/components/charts/stat-card";
import { MessageSquare, ThumbsUp, ThumbsDown } from "lucide-react";
import type { LeadFeedback, Campaign } from "@/types/app";

export default function FeedbackPage() {
  const { data, loading } = useSupabaseQuery("admin-feedback", async (supabase) => {
    const [feedbackRes, campaignsRes] = await Promise.all([
      supabase.from("lead_feedback").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("campaigns").select("id, name"),
    ]);
    return {
      feedback: (feedbackRes.data || []) as LeadFeedback[],
      campaigns: (campaignsRes.data || []) as Pick<Campaign, "id" | "name">[],
    };
  });

  const { feedback, campaigns } = data || { feedback: [], campaigns: [] };
  const campaignMap = new Map(campaigns.map((c) => [c.id, c.name]));
  const rows = feedback.map(f => ({
    ...f,
    campaignName: campaignMap.get(f.campaign_id) || ""
  }));
  const { sorted, sortConfig, requestSort } = useSort(rows);
  const total = feedback.length;
  const good = feedback.filter((f) => ["good_lead", "interested"].includes(f.status)).length;
  const bad = feedback.filter((f) => ["bad_lead", "wrong_person", "not_interested"].includes(f.status)).length;

  if (loading) return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EBF5FE 0%, #D6ECFB 50%, #fff 100%)', border: '1px solid rgba(30,143,232,0.2)', borderTop: '1px solid rgba(30,143,232,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(30,143,232,0.1)' }}>
        <div className="relative z-10"><p className="text-xs font-medium text-[#64748b]">Client Submissions</p><h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Lead Feedback</h1><p className="text-sm text-[#0f172a]/60 mt-1">{total} total submissions from clients</p></div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(71,165,237,0.06)]" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Feedback" value={total} icon={<MessageSquare size={18} className="text-[#1E8FE8]" />} iconBg="bg-[#1E8FE8]/10" />
        <StatCard label="Positive" value={good} icon={<ThumbsUp size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Negative" value={bad} icon={<ThumbsDown size={18} className="text-red-500" />} iconBg="bg-red-50" valueColor="text-red-600" />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#1E8FE8]/10"><MessageSquare size={16} className="text-[#1E8FE8]" /></div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">All Feedback</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {feedback.length === 0 ? <p className="text-sm text-muted-foreground">No feedback yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="lead_email" sortConfig={sortConfig} onSort={requestSort}>Lead</SortableHead><SortableHead sortKey="campaignName" sortConfig={sortConfig} onSort={requestSort}>Campaign</SortableHead><SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead><SortableHead sortKey="comment" sortConfig={sortConfig} onSort={requestSort}>Comment</SortableHead><SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>Date</SortableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((f) => (
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
        </CardContent>
      </Card>
    </div>
  );
}
