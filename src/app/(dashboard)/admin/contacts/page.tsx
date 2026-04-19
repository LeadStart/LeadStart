"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { useUser } from "@/hooks/use-user";
import { SortableHead } from "@/components/ui/sortable-head";
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
import { StatCard } from "@/components/charts/stat-card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  Plus,
  CheckCircle,
  Upload,
  AlertCircle,
  TrendingUp,
  ChevronDown,
} from "lucide-react";
import type { Contact, ContactStatus, ProspectStage } from "@/types/app";
import { ImportContactsDialog } from "./import-dialog";

const PIPELINE_STAGES: { value: ProspectStage; label: string }[] = [
  { value: "lead", label: "Lead" },
  { value: "contacted", label: "Contacted" },
  { value: "meeting", label: "Meeting" },
  { value: "proposal", label: "Proposal" },
  { value: "closed", label: "Closed Won" },
  { value: "lost", label: "Lost" },
];

function pipelineStageLabel(s: ProspectStage): string {
  return PIPELINE_STAGES.find((p) => p.value === s)?.label ?? s;
}

// Tags cell that keeps rows at a single-row height by default and reveals
// the full list on click. Chevron only appears when tags actually overflow.
function TagsCell({ tags }: { tags: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const first = el.firstElementChild as HTMLElement | null;
      const last = el.lastElementChild as HTMLElement | null;
      if (!first || !last || first === last) {
        setOverflowing(false);
        return;
      }
      setOverflowing(last.offsetTop > first.offsetTop);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags]);

  if (!tags || tags.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex items-start gap-1.5">
      <div
        ref={ref}
        className={`flex flex-wrap gap-1 flex-1 ${
          expanded ? "" : "max-h-[26px] overflow-hidden"
        }`}
      >
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="badge-green">
            {tag}
          </Badge>
        ))}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          aria-label={expanded ? "Collapse tags" : "Expand tags"}
          className="shrink-0 flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground cursor-pointer transition-colors"
        >
          <ChevronDown
            size={14}
            className={`transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      )}
    </div>
  );
}

// Visible statuses — user-selectable in filter + form.
// Note: "unsubscribed" remains in the DB enum (set by webhooks) but isn't
// a manually-selectable state in the UI.
const VISIBLE_STATUSES: ContactStatus[] = [
  "new",
  "enriched",
  "uploaded",
  "active",
  "bounced",
  "replied",
];

function statusLabel(s: ContactStatus) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type OwnerView = "leadstart" | "client";

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  phone: string;
  linkedin: string;
  tags: string;
  notes: string;
  pipelineStage: ProspectStage | "none";
  clientId: string;
  owner: OwnerView;
};

const EMPTY_FORM: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  company: "",
  title: "",
  phone: "",
  linkedin: "",
  tags: "",
  notes: "",
  pipelineStage: "none",
  clientId: "",
  owner: "leadstart",
};

function contactToForm(c: Contact): FormState {
  return {
    firstName: c.first_name ?? "",
    lastName: c.last_name ?? "",
    email: c.email ?? "",
    company: c.company_name ?? "",
    title: c.title ?? "",
    phone: c.phone ?? "",
    linkedin: c.linkedin_url ?? "",
    tags: (c.tags ?? []).join(", "),
    notes: c.notes ?? "",
    pipelineStage: c.pipeline_stage ?? "none",
    clientId: c.client_id ?? "",
    owner: c.client_id ? "client" : "leadstart",
  };
}

export default function ContactsPage() {
  const { organizationId } = useUser();
  const { mutate: swrMutate } = useSWRConfig();
  const [ownerView, setOwnerView] = useState<OwnerView>("leadstart");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [clientFilter, setClientFilter] = useState<string>("all");

  // Unified dialog state — null = closed, "add" = new, Contact = edit
  const [dialogMode, setDialogMode] = useState<"add" | Contact | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data, loading, refetch } = useSupabaseQuery(
    "admin-contacts",
    async (supabase) => {
      const [contactsRes, clientsRes] = await Promise.all([
        supabase.from("contacts").select("*").order("created_at", { ascending: false }),
        supabase.from("clients").select("id, name"),
      ]);
      return {
        contacts: (contactsRes.data || []) as Contact[],
        clients: (clientsRes.data || []) as { id: string; name: string }[],
      };
    },
  );

  const allContacts = data?.contacts ?? [];
  const clients = data?.clients ?? [];
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  // Split by owner. LeadStart contacts (client_id IS NULL) are the agency's
  // own prospects — they're the only ones eligible for the Prospects kanban.
  // Client contacts belong to a client's campaign recipient list.
  const contacts = allContacts.filter((c) =>
    ownerView === "leadstart" ? c.client_id === null : c.client_id !== null,
  );

  const totalContacts = contacts.length;
  const enrichedCount = contacts.filter((c) => c.status === "enriched").length;
  const uploadedCount = contacts.filter((c) => c.status === "uploaded").length;
  const needsEnrichment = contacts.filter((c) => c.status === "new").length;

  const filtered = contacts.filter((c) => {
    const matchesSearch =
      !search ||
      (c.first_name || "").toLowerCase().includes(search.toLowerCase()) ||
      (c.last_name || "").toLowerCase().includes(search.toLowerCase()) ||
      c.email.toLowerCase().includes(search.toLowerCase()) ||
      (c.company_name || "").toLowerCase().includes(search.toLowerCase());
    const matchesStatus = statusFilter === "all" || c.status === statusFilter;
    const matchesClient =
      ownerView === "leadstart" || clientFilter === "all" || c.client_id === clientFilter;
    return matchesSearch && matchesStatus && matchesClient;
  });

  const rows = filtered.map((contact) => ({
    ...contact,
    fullName: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "—",
    clientName: contact.client_id ? clientMap.get(contact.client_id) || "—" : "—",
  }));
  const { sorted, sortConfig, requestSort } = useSort(rows, "created_at", "desc");

  if (loading) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="rounded-xl h-36 bg-muted/50" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-xl h-28 bg-muted/50" />
          ))}
        </div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  function openForAdd() {
    setForm({ ...EMPTY_FORM, owner: ownerView });
    setDialogMode("add");
  }

  function openForEdit(contact: Contact) {
    setForm(contactToForm(contact));
    setDialogMode(contact);
  }

  function closeDialog() {
    setDialogMode(null);
    setForm(EMPTY_FORM);
  }

  const editing = dialogMode && dialogMode !== "add" ? dialogMode : null;
  const isDialogOpen = dialogMode !== null;

  async function handleSubmit() {
    if (!form.email.trim()) return;
    if (form.owner === "client" && !form.clientId) {
      alert("Client contacts must be assigned to a client.");
      return;
    }
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const now = new Date().toISOString();

      // Owner enforcement: LeadStart contacts never have client_id; Client
      // contacts never have pipeline_stage. The Prospects kanban additionally
      // filters on client_id IS NULL so client contacts can't leak in.
      const resolvedClientId =
        form.owner === "leadstart" ? null : form.clientId || null;
      const nextStage: ProspectStage | null =
        form.owner === "client"
          ? null
          : form.pipelineStage === "none"
            ? null
            : form.pipelineStage;
      const prevStage: ProspectStage | null = editing?.pipeline_stage ?? null;

      // Pipeline state transitions. Null means "not in the pipeline".
      // Entering the pipeline sets sort order (bottom of the target column)
      // and added_at; leaving clears them.
      const pipelinePatch: {
        pipeline_stage: ProspectStage | null;
        pipeline_sort_order?: number;
        pipeline_added_at?: string | null;
      } = { pipeline_stage: nextStage };
      if (nextStage && !prevStage) {
        pipelinePatch.pipeline_sort_order = allContacts.filter(
          (c) => c.pipeline_stage === nextStage,
        ).length;
        pipelinePatch.pipeline_added_at = now;
      } else if (!nextStage && prevStage) {
        pipelinePatch.pipeline_added_at = null;
      }

      const basePayload = {
        first_name: form.firstName.trim() || null,
        last_name: form.lastName.trim() || null,
        email: form.email.trim(),
        company_name: form.company.trim() || null,
        title: form.title.trim() || null,
        phone: form.phone.trim() || null,
        linkedin_url: form.linkedin.trim() || null,
        tags,
        notes: form.notes.trim() || null,
        client_id: resolvedClientId,
        updated_at: now,
      };

      if (editing) {
        const { error } = await supabase
          .from("contacts")
          .update({ ...basePayload, ...pipelinePatch })
          .eq("id", editing.id);
        if (error) {
          alert(`Failed to save contact: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("contacts").insert({
          ...basePayload,
          ...pipelinePatch,
          id: crypto.randomUUID(),
          organization_id: organizationId,
          enrichment_data: {},
          source: null,
          campaign_id: null,
          status: "new",
          created_at: now,
        });
        if (error) {
          alert(`Failed to add contact: ${error.message}`);
          return;
        }
      }
      await refetch();
      closeDialog();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10 flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">
              {ownerView === "leadstart"
                ? "Agency Prospects"
                : "Client Campaign Recipients"}
            </p>
            <h1
              className="text-[20px] sm:text-[22px] font-bold mt-1"
              style={{ color: "#0f172a", letterSpacing: "-0.01em" }}
            >
              Contacts
            </h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {totalContacts} total · {enrichedCount} enriched · {uploadedCount} uploaded
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setImportOpen(true)}
              variant="outline"
              className="bg-white/40 hover:bg-white/60 text-[#0f172a] border-[#2E37FE]/20"
            >
              <Upload size={16} className="mr-1" />
              Import CSV
            </Button>
            <Button
              onClick={openForAdd}
              className="bg-white/15 hover:bg-white/25 text-[#0f172a] border-0"
            >
              <Plus size={16} className="mr-1" />
              Add Contact
            </Button>
          </div>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Owner toggle — separates LeadStart's own prospects from client
          campaign recipient lists. Only LeadStart contacts pipe into the
          Prospects kanban (enforced on the Prospects page query too). */}
      <div
        className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/40 p-1 shadow-sm"
        role="tablist"
      >
        {([
          { value: "leadstart", label: "LeadStart" },
          { value: "client", label: "Client" },
        ] as { value: OwnerView; label: string }[]).map((opt) => {
          const active = ownerView === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOwnerView(opt.value)}
              className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                active
                  ? "bg-white text-[#0f172a] shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              style={active ? { color: "#2E37FE" } : undefined}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Contacts" value={totalContacts} icon={<Users size={18} className="text-[#2E37FE]" />} iconBg="bg-[#2E37FE]/10" />
        <StatCard label="Enriched" value={enrichedCount} icon={<CheckCircle size={18} className="text-blue-500" />} iconBg="bg-blue-50" valueColor="text-blue-600" />
        <StatCard label="Uploaded" value={uploadedCount} icon={<Upload size={18} className="text-emerald-500" />} iconBg="bg-emerald-50" valueColor="text-emerald-600" />
        <StatCard label="Needs Enrichment" value={needsEnrichment} icon={<AlertCircle size={18} className="text-amber-500" />} iconBg="bg-amber-50" valueColor={needsEnrichment > 0 ? "text-amber-600" : undefined} />
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search contacts..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          style={{ height: "36px" }}
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter((v ?? "all") as ContactStatus | "all")}
        >
          <SelectTrigger className="w-[160px]" style={{ height: "36px" }}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {VISIBLE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {ownerView === "client" ? (
          <Select
            value={clientFilter}
            onValueChange={(v) => setClientFilter(v ?? "all")}
          >
            <SelectTrigger className="w-[180px]" style={{ height: "36px" }}>
              <SelectValue placeholder="Client" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Clients</SelectItem>
              {clients.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {/* Contacts table — row click opens edit dialog */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead sortKey="fullName" sortConfig={sortConfig} onSort={requestSort}>
                    Name
                  </SortableHead>
                  <SortableHead sortKey="email" sortConfig={sortConfig} onSort={requestSort}>
                    Email
                  </SortableHead>
                  <SortableHead sortKey="company_name" sortConfig={sortConfig} onSort={requestSort}>
                    Company
                  </SortableHead>
                  <TableHead>Tags</TableHead>
                  <SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>
                    Created
                  </SortableHead>
                  <TableHead className="text-right w-[150px]">Pipeline Stage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => {
                  const pipelineStage = row.pipeline_stage;
                  return (
                    <TableRow
                      key={row.id}
                      onClick={() => openForEdit(row)}
                      className="cursor-pointer transition-colors hover:bg-muted/40"
                    >
                      <TableCell className="font-medium">{row.fullName}</TableCell>
                      <TableCell className="text-muted-foreground">{row.email}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.company_name || "—"}
                      </TableCell>
                      <TableCell>
                        <TagsCell tags={row.tags ?? []} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(row.created_at).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </TableCell>
                      <TableCell className="text-right">
                        {pipelineStage ? (
                          <Badge
                            variant="outline"
                            className="text-[11px] font-medium text-[#2E37FE] border-[#2E37FE]/30 bg-[#2E37FE]/5"
                          >
                            <TrendingUp size={11} className="mr-1" />
                            {pipelineStage}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Unified Contact dialog — Add mode (blank) or Edit mode (pre-filled) */}
      <Dialog open={isDialogOpen} onOpenChange={(v) => { if (!v) closeDialog(); }}>
        <DialogContent className="max-w-lg max-h-[90vh] p-0 gap-0 flex flex-col">
          <DialogHeader className="px-6 pt-6 pb-3 border-b border-border/50 shrink-0">
            <DialogTitle>
              {editing ? "Edit" : "Add"}{" "}
              {form.owner === "leadstart" ? "LeadStart" : "Client"} Contact
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto px-6 pt-4 pb-6 flex-1 min-h-0">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">First Name</Label>
                <Input
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  placeholder="First name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Last Name</Label>
                <Input
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  placeholder="Last name"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Email *</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="email@company.com"
                style={{ height: "36px" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Company</Label>
                <Input
                  value={form.company}
                  onChange={(e) => setForm({ ...form, company: e.target.value })}
                  placeholder="Company name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Job title"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Phone</Label>
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  placeholder="(555) 000-0000"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">LinkedIn URL</Label>
                <Input
                  value={form.linkedin}
                  onChange={(e) => setForm({ ...form, linkedin: e.target.value })}
                  placeholder="https://linkedin.com/in/..."
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Tags (comma-separated)</Label>
              <Input
                value={form.tags}
                onChange={(e) => setForm({ ...form, tags: e.target.value })}
                placeholder="e.g. saas, decision-maker, warm"
                style={{ height: "36px" }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Notes</Label>
              <Textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Any notes about this contact..."
                rows={2}
              />
            </div>
            {/* Owner-specific field: LeadStart contacts get a Pipeline Stage
                selector; Client contacts get a required Client selector. The
                split is enforced in handleSubmit so the DB stays clean. */}
            {form.owner === "leadstart" ? (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Pipeline Stage</Label>
                <Select
                  value={form.pipelineStage}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      pipelineStage: (v ?? "none") as ProspectStage | "none",
                    })
                  }
                >
                  <SelectTrigger className="w-full" style={{ height: "36px" }}>
                    <SelectValue placeholder="Not in pipeline">
                      {form.pipelineStage === "none"
                        ? "Not in pipeline"
                        : pipelineStageLabel(form.pipelineStage)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="min-w-[220px]"
                    alignItemWithTrigger={false}
                  >
                    <SelectItem value="none">Not in pipeline</SelectItem>
                    {PIPELINE_STAGES.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Setting a stage puts this contact in the Prospects kanban.
                </p>
              </div>
            ) : (
              <div className="space-y-1">
                <Label className="text-sm font-medium">Client *</Label>
                <Select
                  value={form.clientId || ""}
                  onValueChange={(v) =>
                    setForm({ ...form, clientId: v ?? "" })
                  }
                >
                  <SelectTrigger className="w-full" style={{ height: "36px" }}>
                    <SelectValue placeholder="Select a client">
                      {form.clientId
                        ? clients.find((c) => c.id === form.clientId)?.name ??
                          "Select a client"
                        : "Select a client"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent
                    className="min-w-[220px]"
                    alignItemWithTrigger={false}
                  >
                    {clients.length === 0 ? (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        No clients yet.
                      </div>
                    ) : (
                      clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Recipient on this client&apos;s cold email campaigns.
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                style={{ background: "#2E37FE" }}
                disabled={
                  !form.email.trim() ||
                  saving ||
                  (form.owner === "client" && !form.clientId)
                }
                onClick={handleSubmit}
              >
                {saving ? "Saving..." : editing ? "Save changes" : "Add Contact"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ImportContactsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        ownerView={ownerView}
        organizationId={organizationId ?? null}
        clients={clients}
        existingContactCount={(stage) =>
          allContacts.filter((c) => c.pipeline_stage === stage).length
        }
        onImported={async () => {
          await refetch();
          // Bulk imports with pipeline_stage need to reach the Prospects
          // kanban too — invalidate its specific cache key.
          await swrMutate("admin-contacts-with-pipeline");
        }}
      />
    </div>
  );
}
