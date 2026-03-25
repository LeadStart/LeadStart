"use client";

import useSWR from "swr";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatCard } from "@/components/charts/stat-card";
import { MessageSquare, ThumbsUp, ThumbsDown } from "lucide-react";
import type { LeadFeedback } from "@/types/app";

const supabase = createClient();

async function fetchClientFeedback() {
  const { data } = await supabase
    .from("lead_feedback")
    .select("*")
    .order("created_at", { ascending: false });

  return (data || []) as LeadFeedback[];
}

export default function ClientFeedbackPage() {
  const { data: feedback } = useSWR("client-feedback", fetchClientFeedback);

  if (!feedback) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-32 rounded-xl bg-muted" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted" />
          ))}
        </div>
        <div className="h-64 rounded-xl bg-muted" />
      </div>
    );
  }

  const total = feedback.length;
  const good = feedback.filter((f) =>
    ["good_lead", "interested"].includes(f.status)
  ).length;
  const bad = feedback.filter((f) =>
    ["bad_lead", "wrong_person", "not_interested"].includes(f.status)
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-xl p-6 text-white" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', boxShadow: '0 10px 30px -5px rgba(99, 102, 241, 0.2)' }}>
        <div className="relative z-10">
          <p className="text-sm font-medium text-white/70">Lead Quality Tracking</p>
          <h1 className="text-2xl font-bold mt-1">My Feedback</h1>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-white/5" />
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Total Submitted"
          value={total}
          icon={<MessageSquare size={18} className="text-indigo-500" />}
          iconBg="bg-indigo-50"
        />
        <StatCard
          label="Positive"
          value={good}
          icon={<ThumbsUp size={18} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
          valueColor="text-emerald-600"
        />
        <StatCard
          label="Negative"
          value={bad}
          icon={<ThumbsDown size={18} className="text-red-500" />}
          iconBg="bg-red-50"
          valueColor="text-red-600"
        />
      </div>

      {/* Feedback table */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50">
            <MessageSquare size={16} className="text-indigo-500" />
          </div>
          <CardTitle className="text-base">Feedback History</CardTitle>
        </CardHeader>
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
                      <Badge
                        variant="secondary"
                        className={
                          ["good_lead", "interested"].includes(f.status)
                            ? "bg-emerald-100 text-emerald-800 border border-emerald-200"
                            : ["bad_lead", "wrong_person", "not_interested"].includes(f.status)
                            ? "bg-red-100 text-red-800 border border-red-200"
                            : "bg-gray-100 text-gray-600 border border-gray-200"
                        }
                      >
                        {f.status.replace(/_/g, " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">{f.comment || "—"}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {new Date(f.created_at).toLocaleDateString()}
                    </TableCell>
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
