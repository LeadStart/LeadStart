"use client";
import { PageHeader } from "@/components/layout/page-header";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Inbox,
  Plus,
  Send,
  Pause,
  Play,
  Trash2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  FlaskConical,
  Loader2,
  Target,
  Globe,
  Mail,
  X,
  Tag,
} from "lucide-react";
import { TagChipInput } from "@/components/mailboxes/tag-chip-input";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";
import { bandBadgeClass, bandLabel } from "@/lib/deliverability/inbox-health";
import { describeCounts, placementStatusLabel } from "@/lib/deliverability/placement";
import type {
  DomainLifecycle,
  HealthComponent,
  NativeMailbox,
  PlacementProbe,
  PlacementResultStatus,
  PlacementTest,
  PlacementTestResult,
  SeedInbox,
  SeedRole,
  SendingDomain,
} from "@/types/app";
import { AddMailboxWizard } from "./add-mailbox-wizard";
import { DomainProvisioningDetail } from "./domain-provisioning-detail";
import { DomainSetupModal } from "./domain-setup-modal";

type MailboxRow = NativeMailbox & {
  sent_today: number;
  bounced_7d: number;
  effective_daily_cap: number;
  total_sent: number;
  warmed: boolean;
  latest_placement: PlacementTest | null;
};

type DomainRow = SendingDomain & { mailbox_count: number };

// Lifecycle → chip label + Tailwind classes for the Sending domains card.
const LIFECYCLE_META: Record<DomainLifecycle, { label: string; cls: string }> = {
  provisioning: { label: "Provisioning", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  warming: { label: "Warming", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  active: { label: "Active", cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  tired: { label: "Tired · draining", cls: "bg-orange-100 text-orange-800 border-orange-200" },
  resting: { label: "Resting", cls: "bg-blue-100 text-blue-800 border-blue-200" },
  burned: { label: "Burned", cls: "bg-red-100 text-red-800 border-red-200" },
  retired: { label: "Retired", cls: "bg-slate-100 text-slate-500 border-slate-200" },
};

type PlacementDetail = {
  test: PlacementTest | null;
  results: PlacementTestResult[];
  seeds_available: number;
};

type Banner = { kind: "success" | "error"; message: string } | null;

const PLACEMENT_POLL_MS = 10_000;

export default function MailboxesPage() {
  const { user } = useUser();
  const [mailboxes, setMailboxes] = useState<MailboxRow[]>([]);
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [expandedDomainId, setExpandedDomainId] = useState<string | null>(null);
  const [setupDomain, setSetupDomain] = useState<DomainRow | null>(null);
  const [seedCount, setSeedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<Banner>(null);

  // Add wizard — the single entry point for inbox / domain / connect.
  const [wizardOpen, setWizardOpen] = useState(false);

  // Per-row in-flight action guard (mailbox id → true)
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  // Tags: one inline per-row editor open at a time, plus bulk "tag selected".
  const [tagsOpenId, setTagsOpenId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState<string[]>([]);
  // Mirror the draft in a ref so "Save tags" reads the freshest value even when
  // an un-Entered chip is committed by the input's onBlur in the same click
  // (the click's closure would otherwise see stale state → drop the tag).
  const tagDraftRef = useRef<string[]>([]);
  const setTagDraftSynced = (v: string[]) => {
    tagDraftRef.current = v;
    setTagDraft(v);
  };
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagDraft, setBulkTagDraft] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  // Which mailbox's detail (health breakdown + placement) is expanded (one at a time).
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Inline test-send form (one at a time) — recipient defaults to the login email.
  const [testOpenId, setTestOpenId] = useState<string | null>(null);
  const [testTo, setTestTo] = useState("");

  // Placement detail per mailbox (latest test + per-seed results), loaded on
  // expand and refreshed by polling while a test is running.
  const [placement, setPlacement] = useState<Record<string, PlacementDetail>>({});

  // Seed panel
  const [seeds, setSeeds] = useState<SeedInbox[]>([]);
  const [seedEmail, setSeedEmail] = useState("");
  const [seedLabel, setSeedLabel] = useState("");
  const [addingSeed, setAddingSeed] = useState(false);
  const [importingSeeds, setImportingSeeds] = useState(false);
  const [seedBusy, setSeedBusy] = useState<Record<string, boolean>>({});
  // IMAP add form (Yahoo, consumer Gmail, generic)
  const [imapOpen, setImapOpen] = useState(false);
  const [imapEmail, setImapEmail] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("993");
  const [imapUsername, setImapUsername] = useState("");
  const [imapPassword, setImapPassword] = useState("");
  const [imapLabel, setImapLabel] = useState("");
  const [addingImap, setAddingImap] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(appUrl("/api/admin/mailboxes"));
      const data = await res.json();
      if (res.ok) {
        setMailboxes(data.mailboxes ?? []);
        setDomains(data.domains ?? []);
        setSeedCount(data.seed_count ?? 0);
      } else setBanner({ kind: "error", message: data.error ?? "Failed to load mailboxes" });
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSeeds = useCallback(async () => {
    try {
      const res = await fetch(appUrl("/api/admin/seed-inboxes"));
      const data = await res.json();
      if (res.ok) {
        setSeeds(data.seeds ?? []);
        setSeedCount((data.seeds ?? []).filter((s: SeedInbox) => s.status === "active").length);
      } else setBanner({ kind: "error", message: data.error ?? "Failed to load seed inboxes" });
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to load seeds" });
    }
  }, []);

  // Fetch the latest placement test for one mailbox. The GET itself performs a
  // check pass when the test is ready to be read, so polling this is what
  // completes a running test. Also mirrors the test onto the row so the
  // Placement column updates without a full reload.
  const loadPlacement = useCallback(async (mailboxId: string) => {
    try {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mailboxId}/placement`));
      const data = await res.json();
      if (!res.ok) return;
      const detail = data as PlacementDetail;
      setPlacement((p) => ({ ...p, [mailboxId]: detail }));
      setMailboxes((rows) =>
        rows.map((r) => (r.id === mailboxId ? { ...r, latest_placement: detail.test } : r)),
      );
    } catch {
      /* transient; next poll retries */
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSeeds();
  }, [load, loadSeeds]);

  // Poll every running test until it completes.
  useEffect(() => {
    const running = mailboxes.filter(
      (m) => m.latest_placement && ["sending", "awaiting"].includes(m.latest_placement.status),
    );
    if (running.length === 0) return;
    const timer = setInterval(() => {
      for (const m of running) void loadPlacement(m.id);
    }, PLACEMENT_POLL_MS);
    return () => clearInterval(timer);
  }, [mailboxes, loadPlacement]);

  async function withBusy(id: string, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function handleToggleStatus(mb: MailboxRow) {
    const next = mb.status === "active" ? "paused" : "active";
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (res.ok) await load();
      else setBanner({ kind: "error", message: data.error ?? "Update failed" });
    });
  }

  function openTest(mb: MailboxRow) {
    setBanner(null);
    if (testOpenId === mb.id) {
      setTestOpenId(null);
      return;
    }
    setTestOpenId(mb.id);
    setTestTo(user?.email ?? "");
  }

  async function submitTest(mb: MailboxRow) {
    setBanner(null);
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}/test`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: testTo.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({
          kind: "success",
          message: `Test email sent from ${mb.email_address} to ${data.to} with the subject “${data.subject}”. Open that inbox and check whether it landed in Inbox, Promotions, or Spam.`,
        });
        setTestOpenId(null);
      } else {
        setBanner({ kind: "error", message: data.error ?? "Test send failed" });
        await load();
      }
    });
  }

  async function handlePlacement(mb: MailboxRow, probe: PlacementProbe) {
    setBanner(null);
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}/placement`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ probe }),
      });
      const data = await res.json();
      if (res.ok) {
        const test = data.test as PlacementTest;
        const results = (data.results ?? []) as PlacementTestResult[];
        setPlacement((p) => ({
          ...p,
          [mb.id]: { test, results, seeds_available: p[mb.id]?.seeds_available ?? results.length },
        }));
        setMailboxes((rows) => rows.map((r) => (r.id === mb.id ? { ...r, latest_placement: test } : r)));
        setExpandedId(mb.id);
        const sent = results.filter((r) => r.status === "pending").length;
        setBanner(
          test.status === "failed"
            ? { kind: "error", message: test.error ?? "Placement test failed to send." }
            : {
                kind: "success",
                message: `Placement test started — ${probe === "campaign" ? "campaign copy" : "a neutral probe"} sent from ${mb.email_address} to ${sent} seed inbox${sent === 1 ? "" : "es"}. Results land below in about a minute.`,
              },
        );
      } else {
        setBanner({ kind: "error", message: data.error ?? "Placement test failed to start" });
      }
    });
  }

  function toggleExpanded(mb: MailboxRow) {
    const next = expandedId === mb.id ? null : mb.id;
    setExpandedId(next);
    if (next && !placement[mb.id]) void loadPlacement(mb.id);
  }

  async function handleDelete(mb: MailboxRow) {
    if (!confirm(`Remove ${mb.email_address}? This can't be undone.`)) return;
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}`), { method: "DELETE" });
      const data = await res.json();
      if (res.ok) await load();
      else setBanner({ kind: "error", message: data.error ?? "Delete failed" });
    });
  }

  // ---- Tags ----

  function openTags(mb: MailboxRow) {
    setBanner(null);
    if (tagsOpenId === mb.id) {
      setTagsOpenId(null);
      return;
    }
    setTagsOpenId(mb.id);
    setTagDraftSynced(mb.tags ?? []);
  }

  async function saveTags(mb: MailboxRow) {
    await withBusy(mb.id, async () => {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mb.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: tagDraftRef.current }),
      });
      const data = await res.json();
      if (res.ok) {
        setTagsOpenId(null);
        await load();
      } else setBanner({ kind: "error", message: data.error ?? "Failed to save tags" });
    });
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function applyBulkTags() {
    if (selectedIds.size === 0 || bulkTagDraft.length === 0) return;
    setBulkBusy(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/mailboxes/tags"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox_ids: [...selectedIds], add: bulkTagDraft }),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({
          kind: "success",
          message: `Tagged ${data.updated ?? selectedIds.size} inbox${
            (data.updated ?? selectedIds.size) === 1 ? "" : "es"
          } with ${bulkTagDraft.map((t) => `“${t}”`).join(", ")}.`,
        });
        setBulkTagDraft([]);
        setBulkTagOpen(false);
        setSelectedIds(new Set());
        await load();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Bulk tag failed" });
      }
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Bulk tag failed" });
    } finally {
      setBulkBusy(false);
    }
  }

  // ---- Seed panel actions ----

  async function handleAddSeed() {
    if (!seedEmail.trim()) return;
    setAddingSeed(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/seed-inboxes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_address: seedEmail.trim(), label: seedLabel.trim() || undefined }),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({ kind: "success", message: `Added seed inbox ${seedEmail.trim()} — delegation verified.` });
        setSeedEmail("");
        setSeedLabel("");
        await loadSeeds();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Failed to add seed inbox" });
      }
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to add seed" });
    } finally {
      setAddingSeed(false);
    }
  }

  async function handleImportSeeds() {
    setImportingSeeds(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/seed-inboxes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ import_sending_mailboxes: true }),
      });
      const data = await res.json();
      if (res.ok) {
        const n = data.imported ?? 0;
        setBanner({
          kind: "success",
          message:
            n > 0
              ? `Added ${n} sending mailbox${n === 1 ? "" : "es"} as seed inbox${n === 1 ? "" : "es"}. Mailboxes on different domains can now probe each other.`
              : "Every sending mailbox is already a seed inbox.",
        });
        await loadSeeds();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Import failed" });
      }
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Import failed" });
    } finally {
      setImportingSeeds(false);
    }
  }

  async function withSeedBusy(id: string, fn: () => Promise<void>) {
    setSeedBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
    } finally {
      setSeedBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function handleToggleSeed(seed: SeedInbox) {
    const next = seed.status === "active" ? "paused" : "active";
    await withSeedBusy(seed.id, async () => {
      const res = await fetch(appUrl(`/api/admin/seed-inboxes/${seed.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json();
      if (res.ok) await loadSeeds();
      else setBanner({ kind: "error", message: data.error ?? "Update failed" });
    });
  }

  async function handleDeleteSeed(seed: SeedInbox) {
    if (!confirm(`Remove seed inbox ${seed.email_address}?`)) return;
    await withSeedBusy(seed.id, async () => {
      const res = await fetch(appUrl(`/api/admin/seed-inboxes/${seed.id}`), { method: "DELETE" });
      const data = await res.json();
      if (res.ok) await loadSeeds();
      else setBanner({ kind: "error", message: data.error ?? "Delete failed" });
    });
  }

  async function handleSetSeedRole(seed: SeedInbox, role: SeedRole | null) {
    await withSeedBusy(seed.id, async () => {
      const res = await fetch(appUrl(`/api/admin/seed-inboxes/${seed.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const data = await res.json();
      if (res.ok) await loadSeeds();
      else setBanner({ kind: "error", message: data.error ?? "Update failed" });
    });
  }

  async function handleAddImapSeed() {
    const email = imapEmail.trim();
    const host = imapHost.trim();
    if (!email || !host || !imapPassword) return;
    setAddingImap(true);
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/seed-inboxes"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "imap",
          email_address: email,
          label: imapLabel.trim() || undefined,
          imap: {
            host,
            port: Number(imapPort) || 993,
            username: imapUsername.trim() || undefined,
            password: imapPassword,
          },
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setBanner({ kind: "success", message: `Added IMAP seed ${email} — sign-in verified.` });
        setImapEmail("");
        setImapHost("");
        setImapPort("993");
        setImapUsername("");
        setImapPassword("");
        setImapLabel("");
        setImapOpen(false);
        await loadSeeds();
      } else {
        setBanner({ kind: "error", message: data.error ?? "Failed to add IMAP seed" });
      }
    } catch (err) {
      setBanner({ kind: "error", message: err instanceof Error ? err.message : "Failed to add IMAP seed" });
    } finally {
      setAddingImap(false);
    }
  }

  async function handleConnectMicrosoft() {
    setBanner(null);
    try {
      const res = await fetch(appUrl("/api/admin/seed-inboxes/oauth/microsoft/start"), {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok && data.url) {
        window.location.href = data.url; // full-page nav to Microsoft consent
      } else {
        setBanner({ kind: "error", message: data.error ?? "Could not start the Microsoft connect flow" });
      }
    } catch (err) {
      setBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Could not start the Microsoft connect flow",
      });
    }
  }

  // Surface the outcome of a Microsoft connect round-trip once, then clean the URL.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const seed = params.get("seed");
    if (seed === "connected") {
      setBanner({ kind: "success", message: "Microsoft seed connected." });
    } else if (seed === "failed") {
      const reason = params.get("reason");
      setBanner({
        kind: "error",
        message: `Microsoft connect failed${reason ? ` (${reason.replace(/_/g, " ")})` : ""}. Please try again.`,
      });
    }
    if (seed) {
      params.delete("seed");
      params.delete("reason");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
  }, []);

  // Distinct org tags (case-insensitive, first-casing wins) for autocomplete, and
  // whether every listed inbox is bulk-selected (drives the header select-all).
  const orgTags = (() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of mailboxes) {
      for (const t of m.tags ?? []) {
        const k = t.toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(t);
        }
      }
    }
    return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  })();
  const allSelected = mailboxes.length > 0 && mailboxes.every((m) => selectedIds.has(m.id));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Mailboxes"
        actions={
          <Button onClick={() => setWizardOpen(true)}>
            <Plus size={16} className="mr-1" /> Add
          </Button>
        }
      />
      <AddMailboxWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        domains={domains}
        onDone={load}
      />

      {banner && (
        <div
          className={
            banner.kind === "success"
              ? "flex items-center gap-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3"
              : "flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 p-3"
          }
        >
          {banner.kind === "success" ? (
            <CheckCircle size={16} className="text-emerald-500 shrink-0" />
          ) : (
            <XCircle size={16} className="text-red-500 shrink-0" />
          )}
          <span
            className={
              banner.kind === "success"
                ? "text-sm font-medium text-emerald-700"
                : "text-sm font-medium text-red-700"
            }
          >
            {banner.message}
          </span>
        </div>
      )}

      {/* Two-column board: inbox management on the left, domains + provisioning
          on the right, so setting up a domain no longer sits far down the page. */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2 xl:items-start">
      <div className="space-y-6">
      {/* List */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500">
            <Inbox size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">
            Sending inboxes {mailboxes.length > 0 && <span className="text-muted-foreground font-normal">({mailboxes.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground py-6 text-center">Loading…</p>
          ) : mailboxes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No mailboxes yet. Add one above once its domain has authorized the
              service account in Google Admin.
            </p>
          ) : (
            <>
            {/* Bulk "tag selected" toolbar — appears once any inbox is checked. */}
            {selectedIds.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-[#2E37FE]/30 bg-[#2E37FE]/5 px-3 py-2">
                <span className="text-xs font-medium text-[#2E37FE]">
                  {selectedIds.size} selected
                </span>
                {!bulkTagOpen ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setBulkTagOpen(true);
                        setBulkTagDraft([]);
                      }}
                    >
                      <Tag size={13} /> Add tag
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
                      Clear
                    </Button>
                  </>
                ) : (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    <div className="min-w-[12rem] flex-1">
                      <TagChipInput
                        value={bulkTagDraft}
                        onChange={setBulkTagDraft}
                        suggestions={orgTags}
                        autoFocus
                        disabled={bulkBusy}
                        placeholder="Tag name…"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={applyBulkTags}
                      disabled={bulkBusy || bulkTagDraft.length === 0}
                    >
                      {bulkBusy ? <Loader2 size={13} className="animate-spin" /> : <Tag size={13} />}{" "}
                      Apply to {selectedIds.size}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setBulkTagOpen(false);
                        setBulkTagDraft([]);
                      }}
                      disabled={bulkBusy}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-2 font-medium">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = !allSelected && selectedIds.size > 0;
                        }}
                        onChange={() =>
                          setSelectedIds(
                            allSelected ? new Set() : new Set(mailboxes.map((m) => m.id)),
                          )
                        }
                        className="h-3.5 w-3.5 accent-[#2E37FE]"
                        aria-label="Select all mailboxes"
                      />
                    </th>
                    <th className="py-2 pr-3 font-medium">Mailbox</th>
                    <th className="py-2 px-3 font-medium">Status</th>
                    <th className="py-2 px-3 font-medium">Health</th>
                    <th className="py-2 px-3 font-medium">Ramp</th>
                    <th className="py-2 px-3 font-medium">Today</th>
                    <th className="py-2 px-3 font-medium">Bounces 7d</th>
                    <th className="py-2 px-3 font-medium">Placement</th>
                    <th className="py-2 pl-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mailboxes.map((mb) => (
                    <Fragment key={mb.id}>
                    <tr className="border-b last:border-0 align-middle">
                      <td className="py-3 pr-2">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(mb.id)}
                          onChange={() => toggleSelect(mb.id)}
                          className="h-3.5 w-3.5 accent-[#2E37FE]"
                          aria-label={`Select ${mb.email_address}`}
                        />
                      </td>
                      <td className="py-3 pr-3">
                        <div className="font-medium text-[#0f172a]">{mb.email_address}</div>
                        {mb.display_name && (
                          <div className="text-xs text-muted-foreground">{mb.display_name}</div>
                        )}
                        {mb.status === "error" && mb.last_error && (
                          <div className="text-xs text-red-600 flex items-center gap-1 mt-0.5">
                            <AlertTriangle size={12} /> {mb.last_error}
                          </div>
                        )}
                        {mb.status === "paused" && mb.health_paused_at && (
                          <div className="text-xs text-amber-600 flex items-center gap-1 mt-0.5">
                            <AlertTriangle size={12} /> Paused automatically by the health check — resume when it recovers.
                          </div>
                        )}
                        <div className="mt-1 flex flex-wrap items-center gap-1">
                          {(mb.tags ?? []).map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center rounded-full bg-[#2E37FE]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#2E37FE]"
                            >
                              {t}
                            </span>
                          ))}
                          <button
                            type="button"
                            onClick={() => openTags(mb)}
                            className="inline-flex cursor-pointer items-center gap-0.5 rounded-full border border-dashed border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-[#2E37FE]/50 hover:text-[#2E37FE]"
                            aria-expanded={tagsOpenId === mb.id}
                            title="Edit tags"
                          >
                            <Tag size={9} /> {(mb.tags ?? []).length ? "Edit" : "Tag"}
                          </button>
                        </div>
                      </td>
                      <td className="py-3 px-3">
                        <StatusBadge status={mb.status} />
                      </td>
                      <td className="py-3 px-3">
                        {mb.health_score == null ? (
                          <span
                            className="text-muted-foreground"
                            title="First health check runs within the hour."
                          >
                            —
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => toggleExpanded(mb)}
                            className="inline-flex items-center gap-1.5 cursor-pointer"
                            title="Show the health breakdown and placement results"
                          >
                            <span className="font-semibold text-[#0f172a]">{mb.health_score}</span>
                            {mb.health_band && (
                              <Badge
                                variant="secondary"
                                className={`${bandBadgeClass(mb.health_band)} text-[10px]`}
                              >
                                {bandLabel(mb.health_band)}
                              </Badge>
                            )}
                            <ChevronDown
                              size={12}
                              className={`text-muted-foreground transition-transform ${expandedId === mb.id ? "rotate-180" : ""}`}
                            />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        {mb.warmed ? (
                          <span className="text-emerald-600 font-medium">Warmed</span>
                        ) : (
                          <span className="text-muted-foreground">
                            Warming · {mb.total_sent} sent
                          </span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span className="font-medium">{mb.sent_today}</span>
                        <span className="text-muted-foreground"> / {mb.effective_daily_cap}</span>
                      </td>
                      <td className="py-3 px-3">
                        <span className={mb.bounced_7d > 0 ? "text-amber-600 font-medium" : "text-muted-foreground"}>
                          {mb.bounced_7d}
                        </span>
                      </td>
                      <td className="py-3 px-3">
                        <button
                          type="button"
                          onClick={() => toggleExpanded(mb)}
                          className="cursor-pointer text-left"
                          title="Show placement results"
                        >
                          <PlacementCell test={mb.latest_placement} />
                        </button>
                      </td>
                      <td className="py-3 pl-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => openTest(mb)}
                            title="Send a test email from this inbox to an address you choose"
                            aria-expanded={testOpenId === mb.id}
                          >
                            <Send size={14} />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={
                              busy[mb.id] ||
                              seedCount === 0 ||
                              mb.status === "error" ||
                              (mb.latest_placement != null &&
                                ["sending", "awaiting"].includes(mb.latest_placement.status))
                            }
                            onClick={() => handlePlacement(mb, "neutral")}
                            title={
                              seedCount === 0
                                ? "Add a seed inbox below first"
                                : "Run a placement test (neutral probe to every seed inbox on another domain)"
                            }
                          >
                            <FlaskConical size={14} />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => handleToggleStatus(mb)}
                            title={mb.status === "active" ? "Pause" : "Resume"}
                          >
                            {mb.status === "active" ? <Pause size={14} /> : <Play size={14} />}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy[mb.id]}
                            onClick={() => handleDelete(mb)}
                            title="Remove mailbox"
                          >
                            <Trash2 size={14} className="text-red-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {tagsOpenId === mb.id && (
                      <tr className="bg-slate-50/60 border-b last:border-0">
                        <td colSpan={9} className="px-3 py-3">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <div className="max-w-lg flex-1">
                              <TagChipInput
                                value={tagDraft}
                                onChange={setTagDraftSynced}
                                suggestions={orgTags}
                                autoFocus
                                disabled={busy[mb.id]}
                                placeholder="Add a tag (e.g. Agency, Client A)…"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                disabled={busy[mb.id]}
                                onClick={() => saveTags(mb)}
                              >
                                {busy[mb.id] && <Loader2 size={14} className="animate-spin" />}
                                Save tags
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setTagsOpenId(null)}
                                title="Cancel"
                              >
                                <X size={14} />
                              </Button>
                            </div>
                          </div>
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            Tags group inboxes into named pools you can add to a campaign all at
                            once. Case-insensitive; type and press Enter.
                          </p>
                        </td>
                      </tr>
                    )}
                    {testOpenId === mb.id && (
                      <tr className="bg-slate-50/60 border-b last:border-0">
                        <td colSpan={9} className="px-3 py-3">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                            <div className="space-y-1 flex-1 max-w-md">
                              <Label htmlFor={`test-to-${mb.id}`} className="text-xs font-medium">
                                Send a test email from {mb.email_address} to
                              </Label>
                              <Input
                                id={`test-to-${mb.id}`}
                                type="email"
                                value={testTo}
                                onChange={(e) => setTestTo(e.target.value)}
                                placeholder="you@gmail.com"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void submitTest(mb);
                                }}
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                disabled={busy[mb.id] || !testTo.trim()}
                                onClick={() => submitTest(mb)}
                              >
                                <Send size={14} /> {busy[mb.id] ? "Sending…" : "Send test"}
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setTestOpenId(null)}
                                title="Cancel"
                              >
                                <X size={14} />
                              </Button>
                            </div>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-2">
                            Defaults to your login address. The message is the same short, link-free
                            note the placement test uses, so what you see in that inbox reflects the
                            mailbox — not a “TEST” subject line. Sending to this mailbox itself is
                            refused: a self-send never leaves the tenant and always lands in the inbox.
                          </p>
                        </td>
                      </tr>
                    )}
                    {expandedId === mb.id && (
                      <tr className="bg-slate-50/60 border-b last:border-0">
                        <td colSpan={9} className="px-3 py-3">
                          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                            <div className="space-y-1.5">
                              <p className="text-xs font-semibold text-[#0f172a] uppercase tracking-wide">
                                Health breakdown
                              </p>
                              {mb.health_components ? (
                                mb.health_components.map((c) => (
                                  <div key={c.key} className="flex items-start gap-2 text-xs">
                                    <span
                                      className={`mt-1 h-2 w-2 rounded-full shrink-0 ${dotClass(c.status)}`}
                                    />
                                    <span className="font-medium text-[#0f172a] w-44 shrink-0">
                                      {c.label}
                                    </span>
                                    <span className="text-muted-foreground">{c.detail}</span>
                                  </div>
                                ))
                              ) : (
                                <p className="text-xs text-muted-foreground">
                                  First health check runs within the hour.
                                </p>
                              )}
                              {mb.health_checked_at && (
                                <p className="text-[11px] text-muted-foreground pt-1">
                                  Last checked {new Date(mb.health_checked_at).toLocaleString()}.
                                </p>
                              )}
                            </div>
                            <PlacementPanel
                              mailbox={mb}
                              detail={placement[mb.id]}
                              seedCount={seedCount}
                              busy={!!busy[mb.id]}
                              onRun={(probe) => handlePlacement(mb, probe)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>
      </div>

      <div className="space-y-6">
      {/* Sending domains */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600">
            <Globe size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">
              Sending domains{" "}
              {domains.length > 0 && (
                <span className="text-muted-foreground font-normal">({domains.length})</span>
              )}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              The domains your mailboxes send from, with their burn-prevention lifecycle and health.
              A domain warms up, runs active, then rests and re-warms instead of getting burned.
              Lifecycle automation stays off until it&rsquo;s enabled for your organization.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sending domains yet — add a mailbox and its domain appears here.
            </p>
          ) : (
            <div className="divide-y divide-border/50">
              {domains.map((d) => {
                const meta = LIFECYCLE_META[d.lifecycle_status];
                // Every domain expands to its DNS panel (expected vs live records,
                // SPF/DKIM/DMARC/MX); provisioning domains also show the setup stepper.
                const expandable = true;
                const isOpen = expandedDomainId === d.id;
                return (
                  <div key={d.id} className="py-1">
                    <div
                      className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 ${
                        expandable ? "cursor-pointer" : ""
                      }`}
                      onClick={() => expandable && setExpandedDomainId(isOpen ? null : d.id)}
                    >
                      <span className="text-sm font-medium">{d.domain}</span>
                      <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        {d.tier === "gmail" ? "Google" : "SMTP"}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${meta.cls}`}
                      >
                        {meta.label}
                      </span>
                      {d.health_band && (
                        <Badge className={`${bandBadgeClass(d.health_band)} text-[10px]`}>
                          {bandLabel(d.health_band)}
                          {typeof d.health_score === "number" ? ` · ${d.health_score}` : ""}
                        </Badge>
                      )}
                      {d.lifecycle_status === "active" && d.watch_streak > 0 && (
                        <span className="text-[10px] font-medium text-amber-600">
                          watch {d.watch_streak}d
                        </span>
                      )}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {d.mailbox_count} inbox{d.mailbox_count === 1 ? "" : "es"}
                        {d.max_daily_sends != null && ` · cap ${d.max_daily_sends}/day`}
                      </span>
                      {d.lifecycle_status === "provisioning" && !d.provisioning && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSetupDomain(d);
                          }}
                          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-white hover:bg-primary/90"
                        >
                          Set up inboxes
                        </button>
                      )}
                      {expandable && (
                        <ChevronDown
                          size={14}
                          className={`text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                        />
                      )}
                    </div>
                    {expandable && isOpen && (
                      <div className="pb-2">
                        <DomainProvisioningDetail domain={d} onChange={load} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Seed inboxes */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600">
            <Target size={16} className="text-white" />
          </div>
          <div>
            <CardTitle className="text-base">
              Seed inboxes {seeds.length > 0 && <span className="text-muted-foreground font-normal">({seeds.length})</span>}
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Inboxes you control that we read to see where your mail lands — Workspace inboxes, or
              external Yahoo / consumer Gmail accounts by IMAP. A placement test sends a probe from a
              mailbox to every seed on a different domain, then reads each seed to see where it
              landed — Inbox, Promotions, or Spam — and what the receiver said about SPF, DKIM, and
              DMARC. Nothing in a seed is ever modified.
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {seeds.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              No seed inboxes yet. The quickest panel is your own sending mailboxes — any two on
              different domains can probe each other — then add an external Yahoo or consumer Gmail
              seed below to see how those providers really treat your mail.
            </p>
          ) : (
            <div className="divide-y divide-border rounded-lg border">
              {seeds.map((seed) => {
                const provider = seedProviderMeta(seed.provider);
                const ageDays = seedAgeDays(seed.created_at);
                const dueForRotation = seed.role === "fresh" && ageDays > 90;
                return (
                  <div key={seed.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-[#0f172a] truncate">{seed.email_address}</span>
                        <span
                          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${provider.cls}`}
                        >
                          {provider.label}
                        </span>
                      </div>
                      {seed.label && <div className="text-xs text-muted-foreground">{seed.label}</div>}
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        Added {ageDays} day{ageDays === 1 ? "" : "s"} ago
                        {dueForRotation && (
                          <span className="ml-1 font-medium text-amber-600">· due for rotation</span>
                        )}
                      </div>
                      {seed.status === "error" && seed.last_error && (
                        <div className="text-xs text-red-600 flex items-center gap-1 mt-0.5">
                          <AlertTriangle size={12} /> {seed.last_error}
                        </div>
                      )}
                    </div>
                    <select
                      value={seed.role ?? ""}
                      disabled={seedBusy[seed.id]}
                      onChange={(e) =>
                        handleSetSeedRole(seed, e.target.value === "" ? null : (e.target.value as SeedRole))
                      }
                      className="shrink-0 cursor-pointer rounded-md border border-border bg-white px-1.5 py-1 text-xs text-slate-600"
                      title="Rotation role — a 'fresh' seed is one you rotate quarterly for a true first-contact read"
                    >
                      <option value="">Role…</option>
                      <option value="veteran">Veteran</option>
                      <option value="fresh">Fresh</option>
                    </select>
                    <SeedStatusBadge status={seed.status} />
                    <div className="flex items-center gap-1">
                      {seed.provider === "microsoft_graph" && seed.status === "error" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleConnectMicrosoft}
                          title="Reconnect this Microsoft seed (its sign-in expired)"
                        >
                          Reconnect
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={seedBusy[seed.id]}
                        onClick={() => handleToggleSeed(seed)}
                        title={seed.status === "active" ? "Pause (skip this seed)" : "Resume"}
                      >
                        {seed.status === "active" ? <Pause size={14} /> : <Play size={14} />}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={seedBusy[seed.id]}
                        onClick={() => handleDeleteSeed(seed)}
                        title="Remove seed inbox"
                      >
                        <Trash2 size={14} className="text-red-500" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="seedEmail" className="text-sm font-medium">
                Seed email address
              </Label>
              <Input
                id="seedEmail"
                value={seedEmail}
                onChange={(e) => setSeedEmail(e.target.value)}
                placeholder="seed@another-authorized-domain.com"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="seedLabel" className="text-sm font-medium">
                Label (optional)
              </Label>
              <Input
                id="seedLabel"
                value={seedLabel}
                onChange={(e) => setSeedLabel(e.target.value)}
                placeholder="Workspace – davidcabrera"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleAddSeed} disabled={addingSeed || !seedEmail.trim()}>
              {addingSeed ? "Verifying…" : "Add Workspace seed"}
            </Button>
            <Button
              variant="outline"
              onClick={handleImportSeeds}
              disabled={importingSeeds || mailboxes.length === 0}
              title="Register every sending mailbox as a seed — they're already delegation-verified"
            >
              {importingSeeds ? "Adding…" : "Use sending mailboxes as seeds"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setImapOpen((v) => !v)}
              title="Add a Yahoo, consumer Gmail, or other mailbox by IMAP app password"
            >
              <Mail size={14} className="mr-1" /> Add IMAP seed
            </Button>
            <Button
              variant="outline"
              onClick={handleConnectMicrosoft}
              title="Connect an Outlook.com / Microsoft 365 inbox by OAuth (needs the Microsoft OAuth app in Settings)"
            >
              Connect Microsoft seed
            </Button>
          </div>

          {imapOpen && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                Add an inbox on a provider your prospects actually use — a consumer Gmail, Outlook,
                or Yahoo account you control — read over IMAP with an app password. This measures
                real cold placement to that provider, which your own sending domains can&apos;t.
                <br />
                <span className="text-slate-500">
                  Yahoo: host <code className="text-slate-700">imap.mail.yahoo.com</code>, port 993 —
                  create an app password under Account Security. Consumer Gmail: host{" "}
                  <code className="text-slate-700">imap.gmail.com</code>, port 993 — turn on
                  2-Step Verification, then create an app password.
                </span>
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Email address</Label>
                  <Input value={imapEmail} onChange={(e) => setImapEmail(e.target.value)} placeholder="seed@gmail.com" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Label (optional)</Label>
                  <Input value={imapLabel} onChange={(e) => setImapLabel(e.target.value)} placeholder="Consumer Gmail – fresh" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">IMAP host</Label>
                  <Input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.gmail.com" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Port</Label>
                  <Input value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="993" inputMode="numeric" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">Username (optional — defaults to the email)</Label>
                  <Input value={imapUsername} onChange={(e) => setImapUsername(e.target.value)} placeholder="seed@gmail.com" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs font-medium">App password</Label>
                  <Input type="password" value={imapPassword} onChange={(e) => setImapPassword(e.target.value)} placeholder="16-character app password" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleAddImapSeed}
                  disabled={addingImap || !imapEmail.trim() || !imapHost.trim() || !imapPassword}
                >
                  {addingImap ? "Verifying sign-in…" : "Add IMAP seed"}
                </Button>
                <Button variant="ghost" onClick={() => setImapOpen(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground">
            A seed is any inbox you control that we can read. A <strong>Workspace</strong> seed is on
            a domain that authorized the service account (same setup as a sending mailbox); an{" "}
            <strong>IMAP</strong> seed (Yahoo, consumer Gmail, other) is read with an app password —
            the way to measure placement on the providers your prospects use. Seeds on a
            mailbox&apos;s own domain are skipped for that mailbox — same-tenant delivery is never
            filtered, so it can&apos;t measure anything. Nothing in a seed is ever modified.
          </p>
        </CardContent>
      </Card>
      </div>
      </div>

      {setupDomain && (
        <DomainSetupModal
          domain={setupDomain}
          onClose={() => setSetupDomain(null)}
          onDone={load}
        />
      )}
    </div>
  );
}

function seedProviderMeta(provider: SeedInbox["provider"]): { label: string; cls: string } {
  switch (provider) {
    case "google_workspace":
      return { label: "Workspace", cls: "border-blue-200 bg-blue-50 text-blue-700" };
    case "microsoft_graph":
      return { label: "Microsoft", cls: "border-sky-200 bg-sky-50 text-sky-700" };
    case "imap":
      return { label: "IMAP", cls: "border-violet-200 bg-violet-50 text-violet-700" };
  }
}

function seedAgeDays(createdAt: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000));
}

// ── Placement rendering ───────────────────────────────────────────────────

function PlacementCell({ test }: { test: PlacementTest | null }) {
  if (!test) {
    return (
      <span className="text-muted-foreground" title="Run a placement test to measure where this inbox lands.">
        Not tested
      </span>
    );
  }
  if (test.status === "sending" || test.status === "awaiting") {
    return (
      <span className="inline-flex items-center gap-1.5 text-amber-600 font-medium">
        <Loader2 size={12} className="animate-spin" /> Checking…
      </span>
    );
  }
  if (test.status === "failed") {
    return (
      <span className="text-red-600 font-medium" title={test.error ?? undefined}>
        Failed
      </span>
    );
  }
  const total = test.seeds_total;
  const delivered = test.inbox_count + test.promotions_count;
  let text: string;
  let cls: string;
  if (test.spam_count > 0) {
    text = `${test.spam_count}/${total} spam`;
    cls = "text-red-600";
  } else if (test.missing_count > 0) {
    text = `${test.missing_count}/${total} missing`;
    cls = "text-amber-600";
  } else if (test.promotions_count > test.inbox_count) {
    text = `${delivered}/${total} inbox · promo`;
    cls = "text-amber-600";
  } else {
    text = `${delivered}/${total} inbox`;
    cls = "text-emerald-600";
  }
  return (
    <div>
      <div
        className={`font-medium ${cls}`}
        title={describeCounts({
          total,
          inbox: test.inbox_count,
          promotions: test.promotions_count,
          spam: test.spam_count,
          missing: test.missing_count,
        })}
      >
        {text}
      </div>
      <div className="text-[11px] text-muted-foreground">
        {relativeDay(test.completed_at ?? test.started_at)} · {test.probe === "campaign" ? "campaign copy" : "neutral"}
      </div>
    </div>
  );
}

function PlacementPanel({
  mailbox,
  detail,
  seedCount,
  busy,
  onRun,
}: {
  mailbox: MailboxRow;
  detail: PlacementDetail | undefined;
  seedCount: number;
  busy: boolean;
  onRun: (probe: PlacementProbe) => void;
}) {
  const test = detail?.test ?? mailbox.latest_placement;
  const running = !!test && (test.status === "sending" || test.status === "awaiting");
  const canRun = !busy && !running && seedCount > 0 && mailbox.status !== "error";
  const results = detail?.results ?? [];

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-[#0f172a] uppercase tracking-wide">
        Seed placement
      </p>
      {!test ? (
        <p className="text-xs text-muted-foreground">
          Not tested yet. A placement test sends one probe from this mailbox to each seed inbox on
          another domain and reads back where it landed.
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {running ? (
              <span className="inline-flex items-center gap-1.5 text-amber-600 font-medium">
                <Loader2 size={12} className="animate-spin" /> Checking seed inboxes — results update
                automatically.
              </span>
            ) : test.status === "failed" ? (
              <span className="text-red-600 font-medium">{test.error ?? "The test failed."}</span>
            ) : (
              <span className="font-medium text-[#0f172a]">
                {describeCounts({
                  total: test.seeds_total,
                  inbox: test.inbox_count,
                  promotions: test.promotions_count,
                  spam: test.spam_count,
                  missing: test.missing_count,
                })}
              </span>
            )}{" "}
            <span>
              · {test.probe === "campaign" ? "campaign copy" : "neutral probe"}
              {test.subject ? ` “${test.subject}”` : ""} ·{" "}
              {new Date(test.completed_at ?? test.sent_at ?? test.started_at).toLocaleString()}
              {test.triggered_by === "scheduled" ? " · automatic" : ""}
            </span>
          </p>
          {!detail ? (
            <p className="text-xs text-muted-foreground">Loading seed results…</p>
          ) : results.length === 0 ? (
            <p className="text-xs text-muted-foreground">No seed results recorded.</p>
          ) : (
            <div className="divide-y divide-border rounded-lg border bg-white">
              {results.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
                  <span className="font-medium text-[#0f172a] min-w-0 truncate">{r.seed_email}</span>
                  <Badge variant="secondary" className={`${resultBadgeClass(r.status)} text-[10px]`}>
                    {placementStatusLabel(r.status)}
                  </Badge>
                  <AuthPills result={r} />
                  {r.detail && (r.status === "bounced" || r.status === "send_failed" || r.status === "unreadable") && (
                    <span className="text-muted-foreground truncate" title={r.detail}>
                      {r.detail}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button size="sm" variant="outline" disabled={!canRun} onClick={() => onRun("neutral")}>
          <FlaskConical size={14} /> Run neutral probe
        </Button>
        <Button size="sm" variant="outline" disabled={!canRun} onClick={() => onRun("campaign")}>
          <FlaskConical size={14} /> Run with campaign copy
        </Button>
        {seedCount === 0 && (
          <span className="text-[11px] text-muted-foreground">Add a seed inbox below to enable tests.</span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Neutral = a short link-free note (reputation + auth only). Campaign copy = step 1 of the
        campaign this mailbox sends for, with sample values. If neutral lands and campaign copy
        doesn&apos;t, the copy is the problem; if both go to spam, it&apos;s the domain or mailbox.
      </p>
    </div>
  );
}

function AuthPills({ result }: { result: PlacementTestResult }) {
  const a = result.auth_results;
  if (!a || (a.spf == null && a.dkim == null && a.dmarc == null)) return null;
  const pill = (name: string, verdict: string | null) => {
    if (verdict == null) return null;
    const ok = ["pass", "none", "neutral", "bestguesspass"].includes(verdict);
    return (
      <span
        key={name}
        className={`font-mono text-[10px] ${ok ? "text-emerald-600" : "text-red-600 font-semibold"}`}
        title={a.raw ?? undefined}
      >
        {name}={verdict}
      </span>
    );
  };
  return (
    <span className="inline-flex items-center gap-2">
      {pill("spf", a.spf)}
      {pill("dkim", a.dkim)}
      {pill("dmarc", a.dmarc)}
    </span>
  );
}

function resultBadgeClass(status: PlacementResultStatus): string {
  switch (status) {
    case "inbox":
      return "badge-green";
    case "promotions":
      return "badge-amber";
    case "spam":
    case "bounced":
      return "badge-red";
    case "missing":
    case "other":
      return "badge-amber";
    case "pending":
    case "send_failed":
    case "unreadable":
      return "badge-slate";
  }
}

function relativeDay(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function dotClass(status: HealthComponent["status"]): string {
  switch (status) {
    case "ok":
      return "bg-emerald-500";
    case "warn":
      return "bg-amber-500";
    case "bad":
      return "bg-red-500";
    case "unchecked":
      return "bg-slate-300";
  }
}

function StatusBadge({ status }: { status: NativeMailbox["status"] }) {
  if (status === "active") {
    return <Badge variant="secondary" className="badge-green text-[10px]">Active</Badge>;
  }
  if (status === "paused") {
    return <Badge variant="secondary" className="bg-slate-100 text-slate-600 border border-slate-200 text-[10px]">Paused</Badge>;
  }
  return <Badge variant="secondary" className="badge-red text-[10px]">Error</Badge>;
}

function SeedStatusBadge({ status }: { status: SeedInbox["status"] }) {
  if (status === "active") {
    return <Badge variant="secondary" className="badge-green text-[10px]">Active</Badge>;
  }
  if (status === "paused") {
    return <Badge variant="secondary" className="bg-slate-100 text-slate-600 border border-slate-200 text-[10px]">Paused</Badge>;
  }
  return <Badge variant="secondary" className="badge-red text-[10px]">Error</Badge>;
}
