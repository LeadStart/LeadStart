"use client";

import { useState } from "react";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import { useSort } from "@/hooks/use-sort";
import { SortableHead } from "@/components/ui/sortable-head";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  Plus,
  CheckCircle,
  Upload,
  AlertCircle,
} from "lucide-react";
import type { Contact, ContactStatus } from "@/types/app";

const STATUS_COLORS: Record<ContactStatus, string> = {
  new: "bg-[#e2e8f0] text-[#7A7872]",
  enriched: "badge-blue",
  uploaded: "bg-[#2E37FE]/20 text-[#6B72FF]",
  active: "badge-green",
  bounced: "badge-red",
  replied: "badge-amber",
  unsubscribed: "bg-gray-100 text-gray-500",
};

const ALL_STATUSES: ContactStatus[] = [
  "new",
  "enriched",
  "uploaded",
  "active",
  "bounced",
  "replied",
  "unsubscribed",
];

export default function ContactsPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<ContactStatus | "all">("all");
  const [clientFilter, setClientFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);

  // Add form state
  const [formFirstName, setFormFirstName] = useState("");
  const [formLastName, setFormLastName] = useState("");
  const [formEmail, setFormEmail] = useState("");
  const [formCompany, setFormCompany] = useState("");
  const [formTitle, setFormTitle] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formLinkedin, setFormLinkedin] = useState("");
  const [formIntroLine, setFormIntroLine] = useState("");
  const [formTags, setFormTags] = useState("");
  const [formNotes, setFormNotes] = useState("");
  const [formStatus, setFormStatus] = useState<ContactStatus>("new");
  const [formClientId, setFormClientId] = useState<string>("");

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
    }
  );

  const { contacts, clients } = data || { contacts: [], clients: [] };
  const clientMap = new Map(clients.map((c) => [c.id, c.name]));

  // Stat counts
  const totalContacts = contacts.length;
  const enrichedCount = contacts.filter((c) => c.status === "enriched").length;
  const uploadedCount = contacts.filter((c) => c.status === "uploaded").length;
  const needsEnrichment = contacts.filter((c) => c.status === "new").length;

  // Filtering
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

  // Sorting
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
        <div className="grid grid-cols-4 gap-4">{[1,2,3,4].map(i => <div key={i} className="rounded-xl h-28 bg-muted/50" />)}</div>
        <div className="rounded-xl h-64 bg-muted/50" />
      </div>
    );
  }

  function resetForm() {
    setFormFirstName("");
    setFormLastName("");
    setFormEmail("");
    setFormCompany("");
    setFormTitle("");
    setFormPhone("");
    setFormLinkedin("");
    setFormIntroLine("");
    setFormTags("");
    setFormNotes("");
    setFormStatus("new");
    setFormClientId("");
  }

  async function handleAdd() {
    if (!formEmail.trim()) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const tags = formTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await supabase.from("contacts").insert({
        first_name: formFirstName.trim() || null,
        last_name: formLastName.trim() || null,
        email: formEmail.trim(),
        company_name: formCompany.trim() || null,
        title: formTitle.trim() || null,
        phone: formPhone.trim() || null,
        linkedin_url: formLinkedin.trim() || null,
        intro_line: formIntroLine.trim() || null,
        tags,
        notes: formNotes.trim() || null,
        status: formStatus,
        client_id: formClientId || null,
      });
      await refetch();
      resetForm();
      setShowAdd(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-7 text-[#0f172a]"
        style={{
          background: "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: '1px solid rgba(46,55,254,0.2)',
          borderTop: '1px solid rgba(46,55,254,0.3)',
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10 flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">Campaign Leads</p>
            <h1 className="text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Contacts</h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {totalContacts} total &middot; {enrichedCount} enriched &middot;{" "}
              {uploadedCount} uploaded
            </p>
          </div>
          <Button
            onClick={() => setShowAdd(true)}
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
        <StatCard
          label="Total Contacts"
          value={totalContacts}
          icon={<Users size={18} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Enriched"
          value={enrichedCount}
          icon={<CheckCircle size={18} className="text-blue-500" />}
          iconBg="bg-blue-50"
          valueColor="text-blue-600"
        />
        <StatCard
          label="Uploaded"
          value={uploadedCount}
          icon={<Upload size={18} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
          valueColor="text-emerald-600"
        />
        <StatCard
          label="Needs Enrichment"
          value={needsEnrichment}
          icon={<AlertCircle size={18} className="text-amber-500" />}
          iconBg="bg-amber-50"
          valueColor={needsEnrichment > 0 ? "text-amber-600" : undefined}
        />
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
          onValueChange={(v) => setStatusFilter(v as ContactStatus | "all")}
        >
          <SelectTrigger className="w-[160px]" style={{ height: "36px" }}>
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            {ALL_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={clientFilter}
          onValueChange={(v) => setClientFilter(v)}
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

      {/* Contacts table */}
      <Card className="border-border/50 shadow-sm">
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">No contacts found.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead
                    sortKey="fullName"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Name
                  </SortableHead>
                  <SortableHead
                    sortKey="email"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Email
                  </SortableHead>
                  <SortableHead
                    sortKey="company_name"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Company
                  </SortableHead>
                  <SortableHead
                    sortKey="clientName"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Client
                  </SortableHead>
                  <SortableHead
                    sortKey="status"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Status
                  </SortableHead>
                  <SortableHead
                    sortKey="intro_line"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Intro Line
                  </SortableHead>
                  <SortableHead
                    sortKey="created_at"
                    sortConfig={sortConfig}
                    onSort={requestSort}
                  >
                    Created
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.fullName}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.email}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.company_name || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.clientName}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={STATUS_COLORS[row.status]}
                      >
                        {row.status}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className="text-muted-foreground max-w-[200px] truncate"
                      title={row.intro_line || ""}
                    >
                      {row.intro_line || "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(row.created_at).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Contact Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">First Name</Label>
                <Input
                  value={formFirstName}
                  onChange={(e) => setFormFirstName(e.target.value)}
                  placeholder="First name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Last Name</Label>
                <Input
                  value={formLastName}
                  onChange={(e) => setFormLastName(e.target.value)}
                  placeholder="Last name"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Email *</Label>
              <Input
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                placeholder="email@company.com"
                style={{ height: "36px" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Company</Label>
                <Input
                  value={formCompany}
                  onChange={(e) => setFormCompany(e.target.value)}
                  placeholder="Company name"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Title</Label>
                <Input
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder="Job title"
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Phone</Label>
                <Input
                  value={formPhone}
                  onChange={(e) => setFormPhone(e.target.value)}
                  placeholder="(555) 000-0000"
                  style={{ height: "36px" }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">LinkedIn URL</Label>
                <Input
                  value={formLinkedin}
                  onChange={(e) => setFormLinkedin(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  style={{ height: "36px" }}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Intro Line</Label>
              <Textarea
                value={formIntroLine}
                onChange={(e) => setFormIntroLine(e.target.value)}
                placeholder="Personalized intro line for cold email..."
                rows={2}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Tags (comma-separated)</Label>
              <Input
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
                placeholder="e.g. saas, decision-maker, warm"
                style={{ height: "36px" }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Notes</Label>
              <Textarea
                value={formNotes}
                onChange={(e) => setFormNotes(e.target.value)}
                placeholder="Any notes about this contact..."
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Status</Label>
                <Select
                  value={formStatus}
                  onValueChange={(v) => setFormStatus(v as ContactStatus)}
                >
                  <SelectTrigger style={{ height: "36px" }}>
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    {ALL_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Client</Label>
                <Select
                  value={formClientId}
                  onValueChange={(v) => setFormClientId(v)}
                >
                  <SelectTrigger style={{ height: "36px" }}>
                    <SelectValue placeholder="Select client" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No client</SelectItem>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              className="w-full"
              style={{ background: "#2E37FE" }}
              disabled={!formEmail.trim() || saving}
              onClick={handleAdd}
            >
              {saving ? "Adding..." : "Add Contact"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
