"use client";

import Link from "next/link";
import { useState } from "react";
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
  ExternalLink,
} from "lucide-react";
import type { Contact, ContactStatus } from "@/types/app";

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

const STATUS_COLORS: Record<ContactStatus, string> = {
  new: "bg-[#e2e8f0] text-[#475569]",
  enriched: "badge-blue",
  uploaded: "bg-[#2E37FE]/20 text-[#6B72FF]",
  active: "badge-green",
  bounced: "badge-red",
  replied: "badge-amber",
  unsubscribed: "bg-gray-100 text-gray-500",
};

function statusLabel(s: ContactStatus) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type FormState = {
  firstName: string;
  lastName: string;
  email: string;
  company: string;
  title: string;
  phone: string;
  linkedin: string;
  introLine: string;
  tags: string;
  notes: string;
  status: ContactStatus;
  clientId: string;
};

const EMPTY_FORM: FormState = {
  firstName: "",
  lastName: "",
  email: "",
  company: "",
  title: "",
  phone: "",
  linkedin: "",
  introLine: "",
  tags: "",
  notes: "",
  status: "new",
  clientId: "",
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
    introLine: c.intro_line ?? "",
    tags: (c.tags ?? []).join(", "),
    notes: c.notes ?? "",
    status: c.status,
    clientId: c.client_id ?? "",
  };
}

export default function ContactsPage() {
  const { organizationId } = useUser();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [clientFilter, setClientFilter] = useState<string>("all");

  // Unified dialog state — null = closed, "add" = new, Contact = edit
  const [dialogMode, setDialogMode] = useState<"add" | Contact | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [addingToPipeline, setAddingToPipeline] = useState(false);

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

  const contacts = data?.contacts ?? [];
  const clients = data?.clients ?? [];
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

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
    const matchesClient = clientFilter === "all" || c.client_id === clientFilter;
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
    setForm(EMPTY_FORM);
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
  const dialogPipelineStage = editing
    ? contacts.find((c) => c.id === editing.id)?.pipeline_stage ?? null
    : null;

  async function handleSubmit() {
    if (!form.email.trim()) return;
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    setSaving(true);
    try {
      const supabase = createClient();
      const tags = form.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const now = new Date().toISOString();
      const payload = {
        first_name: form.firstName.trim() || null,
        last_name: form.lastName.trim() || null,
        email: form.email.trim(),
        company_name: form.company.trim() || null,
        title: form.title.trim() || null,
        phone: form.phone.trim() || null,
        linkedin_url: form.linkedin.trim() || null,
        intro_line: form.introLine.trim() || null,
        tags,
        notes: form.notes.trim() || null,
        status: form.status,
        client_id: form.clientId || null,
        updated_at: now,
      };

      if (editing) {
        const { error } = await supabase.from("contacts").update(payload).eq("id", editing.id);
        if (error) {
          alert(`Failed to save contact: ${error.message}`);
          return;
        }
      } else {
        const { error } = await supabase.from("contacts").insert({
          ...payload,
          id: crypto.randomUUID(),
          organization_id: organizationId,
          enrichment_data: {},
          source: null,
          campaign_id: null,
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

  async function handleAddEditingToPipeline() {
    if (!editing) return;
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    setAddingToPipeline(true);
    try {
      const supabase = createClient();
      const leadCount = contacts.filter((c) => c.pipeline_stage === "lead").length;
      const { error } = await supabase
        .from("contacts")
        .update({
          pipeline_stage: "lead",
          pipeline_sort_order: leadCount,
          pipeline_added_at: new Date().toISOString(),
        })
        .eq("id", editing.id);
      if (error) {
        alert(`Failed to add to pipeline: ${error.message}`);
        return;
      }
      await refetch();
    } finally {
      setAddingToPipeline(false);
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
            <p className="text-xs font-medium text-[#64748b]">Campaign Leads</p>
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
          <Button
            onClick={openForAdd}
            className="bg-white/15 hover:bg-white/25 text-[#0f172a] border-0"
          >
            <Plus size={16} className="mr-1" />
            Add Contact
          </Button>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
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
                  <SortableHead sortKey="status" sortConfig={sortConfig} onSort={requestSort}>
                    Status
                  </SortableHead>
                  <SortableHead sortKey="created_at" sortConfig={sortConfig} onSort={requestSort}>
                    Created
                  </SortableHead>
                  <TableHead className="text-right w-[120px]">Pipeline</TableHead>
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
                        <Badge
                          variant="secondary"
                          className={`${STATUS_COLORS[row.status]} min-w-[92px] justify-center`}
                        >
                          {statusLabel(row.status)}
                        </Badge>
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
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit Contact" : "Add Contact"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            {/* Pipeline section — only in edit mode */}
            {editing && (
              <div className="rounded-xl border border-border/50 p-3 flex items-center justify-between gap-3 bg-muted/20">
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Pipeline
                  </p>
                  {dialogPipelineStage ? (
                    <p className="text-sm mt-0.5 flex items-center gap-1.5">
                      <TrendingUp size={13} className="text-[#2E37FE]" />
                      In pipeline · <span className="font-medium">{dialogPipelineStage}</span>
                    </p>
                  ) : (
                    <p className="text-sm mt-0.5 text-muted-foreground">Not in pipeline yet</p>
                  )}
                </div>
                {dialogPipelineStage ? (
                  <Link href="/admin/prospects" onClick={closeDialog}>
                    <Button size="sm" variant="outline" className="shrink-0">
                      View in pipeline
                      <ExternalLink size={12} className="ml-1" />
                    </Button>
                  </Link>
                ) : (
                  <Button
                    size="sm"
                    className="shrink-0"
                    style={{ background: "#2E37FE" }}
                    disabled={addingToPipeline}
                    onClick={handleAddEditingToPipeline}
                  >
                    <Plus size={13} className="mr-1" />
                    {addingToPipeline ? "Adding..." : "Add to pipeline"}
                  </Button>
                )}
              </div>
            )}

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
              <Label className="text-sm font-medium">Intro Line</Label>
              <Textarea
                value={form.introLine}
                onChange={(e) => setForm({ ...form, introLine: e.target.value })}
                placeholder="Personalized intro line for cold email..."
                rows={2}
              />
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
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm({ ...form, status: (v ?? "new") as ContactStatus })}
                >
                  <SelectTrigger style={{ height: "36px" }}>
                    <SelectValue placeholder="Status">{statusLabel(form.status)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {VISIBLE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {statusLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Client</Label>
                <Select
                  value={form.clientId ? form.clientId : "none"}
                  onValueChange={(v) => setForm({ ...form, clientId: !v || v === "none" ? "" : v })}
                >
                  <SelectTrigger style={{ height: "36px" }}>
                    <SelectValue placeholder="No client">
                      {form.clientId
                        ? clients.find((c) => c.id === form.clientId)?.name ?? "No client"
                        : "No client"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No client</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button variant="outline" className="flex-1" onClick={closeDialog}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                style={{ background: "#2E37FE" }}
                disabled={!form.email.trim() || saving}
                onClick={handleSubmit}
              >
                {saving ? "Saving..." : editing ? "Save changes" : "Add Contact"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
