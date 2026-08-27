"use client";

// FlowProgress — read-only view of a flow campaign's live state. A rollup strip
// (enrolled / active / peeled / rates) plus a compact outline of the graph with
// per-node occupancy ("N here") and, on each condition, the Yes/No branch split.
// Reads campaign_enrollments.current_node_id (stamped by the graph runtime), so
// it only means anything once a flow campaign has started sending.

import { Fragment } from "react";
import { Mail, Clock, GitBranch, Bell, MessageSquare, ArrowRight } from "lucide-react";
import type { FlowGraph, FlowNode, FlowConditionTrigger } from "@/lib/flow/graph";
import { subtreeActive, type FlowProgressData } from "@/lib/flow/progress";

const CONDITION_LABEL: Record<FlowConditionTrigger, string> = {
  replied: "they reply (any)",
  reply_interested: "reply — interested",
  reply_objection: "reply — objection",
  reply_not_interested: "reply — not interested",
  reply_ooo: "reply — out of office",
  bounced: "it bounces",
  opened: "they open (retired)",
  clicked: "they click (retired)",
  manual: "a VA marks it (retired)",
};

function nodeLabel(n: FlowNode): { icon: React.ReactNode; text: string } {
  switch (n.kind) {
    case "email":
      return { icon: <Mail size={13} />, text: n.subject?.trim() || "Follow-up email (Re:)" };
    case "linkedin":
      return {
        icon: <MessageSquare size={13} />,
        text: n.li_kind === "message" ? "LinkedIn message" : "LinkedIn connect",
      };
    case "internal":
      return { icon: <Bell size={13} />, text: n.label?.trim() || `Automation: ${n.action}` };
    case "wait":
      return { icon: <Clock size={13} />, text: `Wait ${n.wait_days} day${n.wait_days === 1 ? "" : "s"}` };
    case "condition":
      return { icon: <GitBranch size={13} />, text: `If ${CONDITION_LABEL[n.trigger]}` };
  }
}

function Count({ n }: { n: number }) {
  return (
    <span
      className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums ${
        n > 0 ? "bg-[#2E37FE]/10 text-[#2E37FE]" : "bg-muted text-muted-foreground"
      }`}
    >
      {n} here
    </span>
  );
}

export function FlowProgress({ graph, data }: { graph: FlowGraph; data: FlowProgressData }) {
  const r = data.rollup;

  function renderNodes(nodes: FlowNode[], depth = 0) {
    return nodes.map((n) => {
      const { icon, text } = nodeLabel(n);
      if (n.kind === "condition") {
        return (
          <div key={n.id} className="space-y-1.5">
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm">
              <span className="text-slate-500">{icon}</span>
              <span className="font-medium text-foreground">{text}</span>
            </div>
            <div className="ml-3 grid gap-1.5 border-l border-dashed border-border/70 pl-3 sm:grid-cols-2">
              <Branch label="Yes" tone="emerald" count={subtreeActive(n.yes, data.byNode)}>
                {n.yes.length ? renderNodes(n.yes, depth + 1) : <Empty />}
              </Branch>
              <Branch label="No" tone="slate" count={subtreeActive(n.no, data.byNode)}>
                {n.no.length ? renderNodes(n.no, depth + 1) : <Empty />}
              </Branch>
            </div>
          </div>
        );
      }
      const occ = data.byNode[n.id]?.active ?? 0;
      const isWait = n.kind === "wait";
      return (
        <div
          key={n.id}
          className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm ${
            isWait ? "border-transparent text-muted-foreground" : "border-border/60"
          }`}
        >
          <span className="text-slate-500">{icon}</span>
          <span className={`truncate ${isWait ? "" : "text-foreground"}`}>{text}</span>
          {!isWait && <Count n={occ} />}
        </div>
      );
    });
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/60 p-4">
      <div className="flex items-center gap-2">
        <GitBranch size={15} className="text-[#2E37FE]" />
        <p className="text-sm font-semibold text-foreground">Flow progress</p>
        <span className="text-xs text-muted-foreground">where your leads are in the branches right now</span>
      </div>

      {/* Rollup */}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
        <Roll label="Enrolled" value={r.enrolled} />
        <Roll label="Active" value={r.active} tone="text-[#2E37FE]" />
        <Roll label="Peeled" value={r.replied} tone="text-emerald-600" hint="replied → halted" />
        <Roll label="Completed" value={r.completed} />
        <Roll label="Failed" value={r.failed} tone={r.failed > 0 ? "text-red-600" : undefined} />
        <Roll label="Not started" value={r.notStarted} />
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
        <span>
          Reply rate: <strong className="text-foreground">{r.replyRatePct}%</strong> ({r.repliedContacts})
        </span>
        <span>
          Positive reply rate: <strong className="text-emerald-600">{r.positiveRatePct}%</strong> ({r.positiveContacts})
        </span>
      </div>

      {/* Read-only flow outline */}
      <div className="space-y-1.5 border-t border-border/50 pt-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          <ArrowRight size={11} /> Lead enrolled
        </div>
        {graph.nodes.length ? renderNodes(graph.nodes) : <Empty />}
      </div>
    </div>
  );
}

function Branch({
  label,
  tone,
  count,
  children,
}: {
  label: string;
  tone: "emerald" | "slate";
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
            tone === "emerald" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"
          }`}
        >
          {label}
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{count} flowing</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Empty() {
  return <p className="px-1 text-[11px] italic text-muted-foreground">— end —</p>;
}

function Roll({ label, value, tone, hint }: { label: string; value: number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/50 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-bold tabular-nums ${tone ?? "text-foreground"}`}>{value}</p>
      {hint && <p className="text-[9px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
