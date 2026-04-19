"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StatCard } from "@/components/charts/stat-card";
import { FeedbackDonut } from "@/components/charts/feedback-donut";
import { MessageSquare, ThumbsUp, ThumbsDown } from "lucide-react";
import type { LeadFeedback } from "@/types/app";

export default function ClientFeedbackPage() {
  const [feedback, setFeedback] = useState<LeadFeedback[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase.from("lead_feedback").select("*").order("created_at", { ascending: false })
      .then(({ data }) => {
        setFeedback((data || []) as LeadFeedback[]);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div className="space-y-6 animate-pulse"><div className="rounded-xl h-36 bg-muted/50" /><div className="grid grid-cols-3 gap-4">{[1,2,3].map(i => <div key={i} className="rounded-xl h-24 bg-muted/50" />)}</div><div className="rounded-xl h-64 bg-muted/50" /></div>;
  }

  const total = feedback.length;
  const good = feedback.filter((f) => ["good_lead", "interested"].includes(f.status)).length;
  const bad = feedback.filter((f) => ["bad_lead", "wrong_person", "not_interested"].includes(f.status)).length;

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10">
          <p className="text-xs font-medium text-[#64748b]">Lead Quality Tracking</p>
          <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>My Feedback</h1>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Submitted" value={total} icon={<MessageSquare size={18} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
        <StatCard label="Positive" value={good} icon={<ThumbsUp size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Negative" value={bad} icon={<ThumbsDown size={18} className="text-red-500" />} iconBg="bg-red-50" valueColor="text-red-600" />
      </div>

      {feedback.length > 0 && (
        <>
        <div className="flex items-center gap-2 mb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><MessageSquare size={16} className="text-white" /></div>
          <h2 className="text-[15px] font-semibold text-[#0f172a]">Response Breakdown</h2>
        </div>
        <Card className="border-border/50 shadow-sm">
          <CardContent>
            <FeedbackDonut feedback={feedback} />
          </CardContent>
        </Card>
        </>
      )}

      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]"><MessageSquare size={16} className="text-white" /></div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">Feedback History</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {feedback.length === 0 ? (
            <p className="text-sm text-muted-foreground">No feedback submitted yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Lead</TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Comment</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {feedback.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium">{f.lead_email}</TableCell>
                    <TableCell>{f.lead_company || "—"}</TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={["good_lead", "interested"].includes(f.status) ? "badge-green" : ["bad_lead", "wrong_person", "not_interested"].includes(f.status) ? "badge-red" : "badge-slate"}>
                        {f.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">{f.comment || "—"}</TableCell>
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
