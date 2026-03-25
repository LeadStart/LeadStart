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
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10"><p className="text-sm font-medium text-white/70">Client Submissions</p><h1 className="text-2xl font-bold mt-1">Lead Feedback</h1><p className="text-sm text-white/60 mt-1">{total} total submissions from clients</p></div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Feedback" value={total} icon={<MessageSquare size={18} className="text-indigo-500" />} iconBg="bg-indigo-50" />
        <StatCard label="Positive" value={good} icon={<ThumbsUp size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Negative" value={bad} icon={<ThumbsDown size={18} className="text-red-500" />} iconBg="bg-red-50" valueColor="text-red-600" />
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3"><div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50"><MessageSquare size={16} className="text-indigo-500" /></div><CardTitle className="text-base">All Feedback</CardTitle></CardHeader>
        <CardContent>
          {feedback.length === 0 ? <p className="text-sm text-muted-foreground">No feedback yet.</p> : (
            <Table>
              <TableHeader><TableRow><SortableHead sortKey="lead_email" sortConfig={sortConfig} onSort={requestSort}>Lead</SortableHead><SortableHead sortKey="campaignName" sortConfig={sortConfig} onSort={requestSort}>Campaign</SortableHead><SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>Status</SortableHead><SortableHead sortKey="comment" sortConfig={sortConfig} onSort={requestSort}>Comment</SortableHead><SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>Date</SortableHead></TableRow></TableHeader>
              <TableBody>
                {sorted.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell><p className="font-medium">{f.lead_email}</p>{f.lead_company && <p className="text-xs text-muted-foreground">{f.lead_company}</p>}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{campaignMap.get(f.campaign_id) || "—"}</TableCell>
                    <TableCell><Badge variant="secondary" className={["good_lead", "interested"].includes(f.status) ? "bg-emerald-100 text-emerald-800 border border-emerald-200" : ["bad_lead", "wrong_person", "not_interested"].includes(f.status) ? "bg-red-100 text-red-800 border border-red-200" : "bg-gray-100 text-gray-600 border border-gray-200"}>{f.status.replace(/_/g, " ")}</Badge></TableCell>
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
