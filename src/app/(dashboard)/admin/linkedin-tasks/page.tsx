"use client";

// LinkedIn to-dos — the VA task inbox. Lists manual_tasks (migration 00088)
// that a FlowGraph `linkedin` node produces: connection requests + direct
// messages a VA sends by hand. The native sender never executes these; they
// only ever exist as rows here for a human to work off. List / complete / skip
// go through /api/admin/manual-tasks (never the browser Supabase client), so
// the join to the contact + campaign happens server-side.

import { useEffect, useMemo, useState } from "react";
import {
  ListChecks,
  Inbox as InboxIcon,
  CheckCircle2,
  SkipForward,
  Check,
  RotateCcw,
  Copy,
  ExternalLink,
  UserPlus,
  MessageSquare,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { useApiQuery } from "@/hooks/use-api-query";
import { useSort } from "@/hooks/use-sort";
import { appUrl } from "@/lib/api-url";
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
import { SortableHead } from "@/components/ui/sortable-head";
import { StatCard } from "@/components/charts/stat-card";
import { PaginationControls } from "@/components/ui/pagination-controls";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ManualTaskStatus,
  ManualTaskWithContext,
} from "@/types/app";

// lucide v1 dropped brand icons; inline the LinkedIn glyph (matches flow-editor).
function LinkedInGlyph({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9h4v12H3zM9 9h3.8v1.7h.05c.53-.95 1.83-1.95 3.77-1.95 4 0 4.75 2.5 4.75 5.8V21H21v-5.9c0-1.4-.03-3.2-2-3.2-2 0-2.3 1.5-2.3 3.1V21H13z" />
    </svg>
  );
}

const PAGE_SIZE = 25;

const KIND_LABEL = {
  linkedin_connect: "Connection request",
  linkedin_message: "Direct message",
} as const;

const STATUS_LABEL: Record<ManualTaskStatus, string> = {
  open: "Open",
  done: "Done",
  skipped: "Skipped",
};

function contactName(c: ManualTaskWithContext["contact"]): string {
  if (!c) return "(unknown contact)";
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ").trim();
  return n || c.email || "(unnamed contact)";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard blocked — no-op */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2 py-1 text-xs font-medium text-[#0f172a] transition-colors hover:bg-muted/40 cursor-pointer"
      title="Copy message"
    >
      {copied ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export default function LinkedInTasksPage() {
  const { data, loading, refetch } = useApiQuery<{ tasks: ManualTaskWithContext[] }>(
    "/api/admin/manual-tasks?status=all",
  );
  const tasks = useMemo(() => data?.tasks ?? [], [data]);

  const openCount = tasks.filter((t) => t.status === "open").length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const skippedCount = tasks.filter((t) => t.status === "skipped").length;

  const [statusFilter, setStatusFilter] = useState<ManualTaskStatus>("open");
  const [pending, setPending] = useState<Record<string, boolean>>({});

  const filtered = useMemo(
    () => tasks.filter((t) => t.status === statusFilter),
    [tasks, statusFilter],
  );

  const { sorted, sortConfig, requestSort } = useSort(filtered);

  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [statusFilter, sortConfig?.key, sortConfig?.direction]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  async function setTaskStatus(id: string, status: ManualTaskStatus) {
    setPending((p) => ({ ...p, [id]: true }));
    try {
      const res = await fetch(appUrl(`/api/admin/manual-tasks/${id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        alert(b.error || `Failed to update task (HTTP ${res.status})`);
        return;
      }
      await refetch();
    } finally {
      setPending((p) => {
        const next = { ...p };
        delete next[id];
        return next;
      });
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-24 bg-muted/50" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl h-24 bg-muted/50" />
          ))}
        </div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="LinkedIn to-dos"
      />

      {/* Stat cards — reflect the full set, not the current filter */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Open" value={openCount} icon={<InboxIcon size={18} className="text-amber-500" />} iconBg="bg-amber-50" valueColor="text-amber-600" />
        <StatCard label="Done" value={doneCount} icon={<CheckCircle2 size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Skipped" value={skippedCount} icon={<SkipForward size={18} className="text-gray-400" />} iconBg="bg-background" />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ManualTaskStatus)}>
          <SelectTrigger className="w-[160px]" style={{ height: "36px" }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="done">Done</SelectItem>
            <SelectItem value="skipped">Skipped</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filtered.length} {STATUS_LABEL[statusFilter].toLowerCase()} task{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex items-center gap-2 mb-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-50">
          <ListChecks size={16} className="text-blue-600" />
        </div>
        <h2 className="text-[15px] font-semibold text-[#0f172a]">LinkedIn to-dos</h2>
      </div>
      <Card className="border-border/50 shadow-sm">
        <CardContent>
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-50">
                <LinkedInGlyph size={20} className="text-blue-600" />
              </div>
              <p className="text-sm font-medium text-[#0f172a]">
                No {STATUS_LABEL[statusFilter].toLowerCase()} LinkedIn to-dos
              </p>
              <p className="max-w-md text-xs text-muted-foreground">
                LinkedIn steps in a campaign flow land here as manual tasks. They appear once a
                campaign with a LinkedIn touch reaches a lead.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Contact</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>LinkedIn</TableHead>
                  <SortableHead sortKey="kind" sortConfig={sortConfig} onSort={requestSort}>Type</SortableHead>
                  <SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>Created</SortableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageRows.map((task) => {
                  const c = task.contact;
                  const busy = !!pending[task.id];
                  return (
                    <TableRow key={task.id}>
                      {/* Contact */}
                      <TableCell className="align-top">
                        <div className="min-w-[150px] max-w-[220px]">
                          <p className="font-medium text-[#0f172a] break-words">{contactName(c)}</p>
                          {c?.title && (
                            <p className="text-xs text-muted-foreground break-words">{c.title}</p>
                          )}
                          {c?.company_name && (
                            <p className="text-xs text-muted-foreground break-words">{c.company_name}</p>
                          )}
                          {task.campaign?.name && (
                            <p className="mt-1 text-[11px] text-muted-foreground/80 break-words">
                              via {task.campaign.name}
                            </p>
                          )}
                        </div>
                      </TableCell>

                      {/* Message to copy */}
                      <TableCell className="align-top">
                        <div className="min-w-[220px] max-w-[420px]">
                          {task.rendered_body ? (
                            <>
                              <p className="whitespace-pre-wrap break-words text-sm text-[#334155]">
                                {task.rendered_body}
                              </p>
                              <div className="mt-1.5">
                                <CopyButton text={task.rendered_body} />
                              </div>
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {task.kind === "linkedin_connect"
                                ? "Connect with no note"
                                : "(no message)"}
                            </span>
                          )}
                        </div>
                      </TableCell>

                      {/* LinkedIn / profile link */}
                      <TableCell className="align-top">
                        {c?.linkedin_url ? (
                          <a
                            href={c.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2 py-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-50 cursor-pointer"
                            title={c.linkedin_url}
                          >
                            <LinkedInGlyph size={12} />
                            Profile
                            <ExternalLink size={11} className="opacity-60" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>

                      {/* Type */}
                      <TableCell className="align-top">
                        <Badge
                          variant="secondary"
                          className={
                            task.kind === "linkedin_connect" ? "badge-blue" : "bg-violet-50 text-violet-700"
                          }
                        >
                          {task.kind === "linkedin_connect" ? (
                            <UserPlus size={12} className="mr-1" />
                          ) : (
                            <MessageSquare size={12} className="mr-1" />
                          )}
                          {KIND_LABEL[task.kind]}
                        </Badge>
                      </TableCell>

                      {/* Created */}
                      <TableCell className="align-top text-sm text-muted-foreground whitespace-nowrap">
                        {new Date(task.created_at).toLocaleDateString()}
                      </TableCell>

                      {/* Action */}
                      <TableCell className="align-top text-right">
                        {task.status === "open" ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setTaskStatus(task.id, "done")}
                              className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50 cursor-pointer"
                            >
                              <Check size={13} />
                              Done
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setTaskStatus(task.id, "skipped")}
                              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2.5 py-1 text-xs font-medium text-[#475569] transition-colors hover:bg-muted/40 disabled:opacity-50 cursor-pointer"
                            >
                              <SkipForward size={13} />
                              Skip
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setTaskStatus(task.id, "open")}
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-white px-2.5 py-1 text-xs font-medium text-[#475569] transition-colors hover:bg-muted/40 disabled:opacity-50 cursor-pointer"
                          >
                            <RotateCcw size={13} />
                            Reopen
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <PaginationControls
            currentPage={safePage}
            totalItems={sorted.length}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>
    </div>
  );
}
