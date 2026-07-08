"use client";

// /admin/inbox/salesforge — full Salesforge inbox.
//
// Two-pane layout: thread list on the left, selected thread detail on
// the right with a reply composer + label picker. Pulls everything in
// one composite call (/api/admin/salesforge/inbox) so the page mounts
// fast.
//
// This is the Salesforge equivalent of /admin/inbox (which is the
// LeadStart-managed reply pipeline). The two are separate concerns:
//   - /admin/inbox       — classified hot replies queued for the client
//   - /admin/inbox/salesforge — the raw Salesforge unibox

import { useEffect, useState, useCallback } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label as UiLabel } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw,
  Search,
  Send,
  Tag,
  Inbox,
  CheckCircle,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface Thread {
  id: string;
  contactEmail?: string;
  contactFirstName?: string;
  contactLastName?: string;
  subject?: string;
  content?: string;
  date?: string;
  isPositive?: boolean;
  isUnread?: boolean;
  labelId?: string;
  mailboxId?: string;
}

interface PrimeboxLabel {
  id: string;
  name: string;
  isBuiltIn?: boolean;
}

interface MailboxOption {
  id: string;
  email: string;
}

interface ThreadDetail {
  contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    company?: string;
  };
  sequence?: { id?: string; name?: string };
  emails?: Array<{
    id: string;
    emailId?: string; // Salesforge's reply target id (used by /reply)
    type?: string;
    subject?: string;
    fromAddress?: string;
    toAddress?: string;
    content?: string;
    date?: string;
  }>;
}

export default function SalesforgeInboxPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [labels, setLabels] = useState<PrimeboxLabel[]>([]);
  const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [mailboxFilter, setMailboxFilter] = useState<string>("");
  const [labelFilter, setLabelFilter] = useState<string>("");

  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const [replyBody, setReplyBody] = useState("");
  const [sendingReply, setSendingReply] = useState(false);
  const [replyResult, setReplyResult] = useState<"success" | "fail" | null>(null);
  const [updatingLabel, setUpdatingLabel] = useState(false);

  const loadThreads = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set("q", searchQuery.trim());
      if (mailboxFilter) params.append("mailbox_ids[]", mailboxFilter);
      if (labelFilter) params.append("labels[]", labelFilter);
      params.set("limit", "100");

      const res = await fetch(appUrl(`/api/admin/salesforge/inbox?${params}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      setThreads(data.threads ?? []);
      setLabels(data.labels ?? []);
      setMailboxes(data.mailboxes ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [searchQuery, mailboxFilter, labelFilter]);

  useEffect(() => {
    void loadThreads();
  }, [loadThreads]);

  async function openThread(thread: Thread) {
    if (!thread.mailboxId) {
      setError("Thread has no mailbox id — can't load detail.");
      return;
    }
    setSelectedThread(thread);
    setThreadDetail(null);
    setReplyBody("");
    setReplyResult(null);
    setLoadingDetail(true);
    try {
      const res = await fetch(
        appUrl(
          `/api/admin/salesforge/threads/${encodeURIComponent(thread.mailboxId)}/${encodeURIComponent(thread.id)}`,
        ),
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
      setThreadDetail(data.thread);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingDetail(false);
    }
  }

  async function sendReply() {
    if (!selectedThread?.mailboxId || !threadDetail?.emails?.length) return;
    if (!replyBody.trim()) return;

    // We reply to the most recent received message in the thread.
    const lastReceived =
      [...threadDetail.emails]
        .reverse()
        .find((e) => e.type === "received") ?? threadDetail.emails[threadDetail.emails.length - 1];
    if (!lastReceived?.emailId && !lastReceived?.id) {
      setError("No reply target found in thread.");
      return;
    }
    const emailId = lastReceived.emailId ?? lastReceived.id;

    setSendingReply(true);
    setReplyResult(null);
    try {
      // Use Salesforge's direct reply endpoint via our existing client.
      // We don't go through /api/replies/[id]/send because that requires
      // a lead_replies row — and Salesforge inbox threads aren't always
      // tracked in our lead_replies pipeline.
      const res = await fetch(appUrl(`/api/admin/salesforge/inbox/reply`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mailbox_id: selectedThread.mailboxId,
          email_id: emailId,
          body_text: replyBody.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Send failed (${res.status})`);
      setReplyResult("success");
      setReplyBody("");
      // Refresh the thread to show the sent reply.
      await openThread(selectedThread);
    } catch (err) {
      setReplyResult("fail");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingReply(false);
    }
  }

  async function updateLabel(labelId: string) {
    if (!selectedThread?.mailboxId) return;
    setUpdatingLabel(true);
    try {
      const res = await fetch(
        appUrl(
          `/api/admin/salesforge/threads/${encodeURIComponent(selectedThread.mailboxId)}/${encodeURIComponent(selectedThread.id)}`,
        ),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label_id: labelId }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Label update failed (${res.status})`);
      // Optimistic UI: update the selected thread's labelId locally.
      setSelectedThread({ ...selectedThread, labelId });
      setThreads((prev) =>
        prev.map((t) => (t.id === selectedThread.id ? { ...t, labelId } : t)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUpdatingLabel(false);
    }
  }

  function fmtDate(iso?: string) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
  function contactName(t: { contactFirstName?: string; contactLastName?: string; contactEmail?: string }) {
    return [t.contactFirstName, t.contactLastName].filter(Boolean).join(" ") || t.contactEmail || "(unknown)";
  }

  return (
    <div className="space-y-6">
      <div
        className="relative overflow-hidden rounded-[12px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "#EDEEFF",
          border: "1px solid #e2e8f0",
        }}
      >
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">Inbox</h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Conversation view across every Salesforge mailbox. For
          classified hot-reply notifications, see /admin/inbox.
        </p>
      </div>

      {/* Filter bar */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px] space-y-1">
            <UiLabel className="text-xs">Search</UiLabel>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search subject, body, contact email…"
                className="pl-9"
                onKeyDown={(e) => e.key === "Enter" && loadThreads()}
              />
            </div>
          </div>
          <div className="space-y-1 min-w-[200px]">
            <UiLabel className="text-xs">Mailbox</UiLabel>
            <Select
              value={mailboxFilter || "all"}
              onValueChange={(v) => setMailboxFilter(v === "all" ? "" : v ?? "")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All mailboxes</SelectItem>
                {mailboxes.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 min-w-[200px]">
            <UiLabel className="text-xs">Label</UiLabel>
            <Select
              value={labelFilter || "all"}
              onValueChange={(v) => setLabelFilter(v === "all" ? "" : v ?? "")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All labels</SelectItem>
                {labels.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            variant="outline"
            onClick={loadThreads}
            disabled={refreshing}
            size="sm"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin mr-1" : "mr-1"} />
            {refreshing ? "Loading…" : "Refresh"}
          </Button>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Two-pane layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-4">
        {/* Threads list */}
        <Card className="border-border/50 shadow-sm overflow-hidden h-[calc(100vh-340px)]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Inbox size={14} />
              {loading ? "Loading…" : `${threads.length} threads`}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-0 overflow-y-auto h-full pb-12">
            {loading ? (
              <div className="p-4 text-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : threads.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No threads match these filters.
              </div>
            ) : (
              <div className="divide-y divide-border/40">
                {threads.map((t) => {
                  const isSelected = selectedThread?.id === t.id;
                  return (
                    <button
                      key={t.id}
                      onClick={() => openThread(t)}
                      className={`w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors ${isSelected ? "bg-[#2E37FE]/5 border-l-2 border-[#2E37FE]" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm font-medium truncate ${t.isUnread ? "text-foreground" : "text-muted-foreground"}`}>
                          {contactName(t)}
                        </span>
                        {t.isPositive && (
                          <Badge className="badge-green text-[10px]">+</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {t.subject || "(no subject)"}
                      </p>
                      <p className="text-[11px] text-muted-foreground/80 mt-0.5 truncate">
                        {t.content?.slice(0, 80) || ""}
                      </p>
                      <p className="text-[10px] text-muted-foreground/60 mt-1">
                        {fmtDate(t.date)}
                      </p>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Thread detail */}
        <Card className="border-border/50 shadow-sm h-[calc(100vh-340px)] overflow-hidden flex flex-col">
          {selectedThread ? (
            <>
              <CardHeader className="pb-3 border-b border-border/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base truncate">
                      {selectedThread.subject || "(no subject)"}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-1">
                      {contactName(selectedThread)} · {selectedThread.contactEmail}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Tag size={14} className="text-muted-foreground" />
                    <Select
                      value={selectedThread.labelId || ""}
                      onValueChange={(v) => v && updateLabel(v)}
                    >
                      <SelectTrigger className="w-[160px] h-8 text-xs" disabled={updatingLabel}>
                        <SelectValue placeholder="No label" />
                      </SelectTrigger>
                      <SelectContent>
                        {labels.map((l) => (
                          <SelectItem key={l.id} value={l.id}>
                            {l.name}
                            {l.isBuiltIn && (
                              <span className="text-muted-foreground ml-1">(built-in)</span>
                            )}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="flex-1 overflow-y-auto p-0">
                {loadingDetail ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    <Loader2 size={20} className="inline animate-spin mr-2" />
                    Loading thread…
                  </div>
                ) : threadDetail?.emails?.length ? (
                  <div className="divide-y divide-border/40">
                    {threadDetail.emails.map((email) => (
                      <div key={email.id} className="p-4 space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium">
                              {email.fromAddress}
                              <Badge
                                variant="secondary"
                                className={`ml-2 text-[10px] ${email.type === "sent" ? "bg-blue-100 text-blue-700" : "bg-emerald-100 text-emerald-700"}`}
                              >
                                {email.type}
                              </Badge>
                            </p>
                            <p className="text-[11px] text-muted-foreground">
                              to {email.toAddress} · {fmtDate(email.date)}
                            </p>
                          </div>
                        </div>
                        {email.subject && email.subject !== selectedThread.subject && (
                          <p className="text-xs font-medium">Subject: {email.subject}</p>
                        )}
                        <div
                          className="text-sm text-foreground/90 whitespace-pre-wrap"
                          // Salesforge returns HTML in `content`. We render
                          // it as text for safety; an HTML renderer is a
                          // future polish.
                        >
                          {email.content?.replace(/<[^>]+>/g, "").trim()}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No messages in this thread.
                  </div>
                )}
              </CardContent>

              {/* Reply box */}
              <div className="border-t border-border/40 p-4 space-y-2">
                <Textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  rows={3}
                  placeholder="Write a reply…"
                  disabled={sendingReply}
                />
                <div className="flex items-center gap-2">
                  <Button
                    onClick={sendReply}
                    disabled={sendingReply || !replyBody.trim()}
                    style={{ background: "#2E37FE" }}
                    size="sm"
                  >
                    {sendingReply ? (
                      <Loader2 size={14} className="animate-spin mr-1" />
                    ) : (
                      <Send size={14} className="mr-1" />
                    )}
                    Send reply
                  </Button>
                  {replyResult === "success" && (
                    <span className="text-sm text-emerald-600 flex items-center gap-1">
                      <CheckCircle size={14} /> Sent
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              Pick a thread on the left.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
