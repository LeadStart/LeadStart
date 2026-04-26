"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useUser } from "@/hooks/use-user";
import { useSupabaseQuery } from "@/hooks/use-supabase-query";
import {
  ADMIN_CONTACTS_PIPELINE_KEY,
  fetchAdminContactsPipeline,
} from "@/lib/admin-queries";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatCard } from "@/components/charts/stat-card";
import {
  Target,
  Plus,
  Phone,
  Mail,
  Globe,
  Calendar,
  Users,
  CheckCircle,
  Trash2,
  ExternalLink,
  Lock,
  UserPlus,
  Search,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Contact, ProspectStage } from "@/types/app";

type StageDef = {
  value: ProspectStage;
  label: string;
  badge: string;
  badgeBorder: string;
  columnBar: string;
  headerTint: string;
};

const STAGES: StageDef[] = [
  { value: "lead", label: "Lead", badge: "bg-[#e2e8f0] text-[#475569]", badgeBorder: "border-slate-200", columnBar: "bg-slate-400", headerTint: "bg-slate-50" },
  { value: "contacted", label: "Contacted", badge: "badge-blue", badgeBorder: "border-blue-200", columnBar: "bg-blue-500", headerTint: "bg-blue-50" },
  { value: "meeting", label: "Meeting", badge: "bg-[#2E37FE]/15 text-[#2E37FE]", badgeBorder: "border-[#2E37FE]/20", columnBar: "bg-[#2E37FE]", headerTint: "bg-[#EDEEFF]" },
  { value: "proposal", label: "Proposal", badge: "badge-amber", badgeBorder: "border-amber-200", columnBar: "bg-amber-500", headerTint: "bg-amber-50" },
  { value: "closed", label: "Closed Won", badge: "badge-green", badgeBorder: "border-emerald-200", columnBar: "bg-emerald-500", headerTint: "bg-emerald-50" },
  { value: "lost", label: "Lost", badge: "badge-red", badgeBorder: "border-red-200", columnBar: "bg-red-400", headerTint: "bg-red-50" },
];

function stageDef(stage: ProspectStage): StageDef {
  return STAGES.find((s) => s.value === stage) ?? STAGES[0];
}

function displayName(c: Contact): string {
  const n = [c.first_name, c.last_name].filter(Boolean).join(" ");
  return n || c.email;
}

function industryOf(c: Contact): string | null {
  const v = (c.enrichment_data as Record<string, unknown> | null)?.["industry"];
  return typeof v === "string" ? v : null;
}

function websiteOf(c: Contact): string | null {
  const v = (c.enrichment_data as Record<string, unknown> | null)?.["website"];
  return typeof v === "string" ? v : null;
}

function ProspectCardInner({
  contact,
  onSelect,
  dragging,
}: {
  contact: Contact;
  onSelect?: () => void;
  dragging?: boolean;
}) {
  const stage = contact.pipeline_stage;
  const isOverdue =
    !!contact.pipeline_follow_up_date &&
    new Date(contact.pipeline_follow_up_date) < new Date() &&
    stage !== null &&
    !["closed", "lost"].includes(stage);
  const companyInitial = (contact.company_name || contact.email || "?").charAt(0).toUpperCase();
  const name = displayName(contact);
  const industry = industryOf(contact);

  return (
    <Card
      onClick={onSelect}
      className={`group cursor-pointer transition-all hover:border-[#2E37FE]/30 hover:shadow-md ${dragging ? "shadow-lg ring-2 ring-[#2E37FE]/30" : ""}`}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-2.5 mb-2">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
            style={{ background: "#2E37FE" }}
          >
            {companyInitial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm text-foreground truncate">
              {contact.company_name || name}
            </p>
            <p className="text-xs text-muted-foreground truncate">{name}</p>
          </div>
        </div>

        {(industry || isOverdue) && (
          <div className="flex items-center gap-1.5 flex-wrap mb-2">
            {industry && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                {industry}
              </Badge>
            )}
            {isOverdue && (
              <Badge variant="secondary" className="text-[10px] badge-red">
                Overdue
              </Badge>
            )}
          </div>
        )}

        {contact.pipeline_notes && (
          <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{contact.pipeline_notes}</p>
        )}

        {(contact.email || contact.pipeline_follow_up_date) && (
          <div className="flex items-center gap-3 pt-2 border-t border-border/30 text-[11px] text-muted-foreground">
            {contact.email && (
              <span className="flex items-center gap-1 truncate">
                <Mail size={10} className="shrink-0" />
                <span className="truncate">{contact.email}</span>
              </span>
            )}
            {contact.pipeline_follow_up_date && (
              <span className="flex items-center gap-1 ml-auto shrink-0">
                <Calendar size={10} />
                {new Date(contact.pipeline_follow_up_date).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SortableProspect({
  contact,
  onSelect,
}: {
  contact: Contact;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: contact.id,
    data: { stage: contact.pipeline_stage },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ProspectCardInner contact={contact} onSelect={onSelect} />
    </div>
  );
}

function KanbanColumn({
  stage,
  contacts,
  onSelect,
}: {
  stage: StageDef;
  contacts: Contact[];
  onSelect: (c: Contact) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${stage.value}`,
    data: { stage: stage.value, type: "column" },
  });

  return (
    <div className="flex flex-col w-[280px] shrink-0 rounded-xl border border-border/50 bg-background/40 overflow-hidden">
      <div className={`flex items-center justify-between px-3 py-2.5 ${stage.headerTint} border-b border-border/50`}>
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full ${stage.columnBar}`} />
          <span className="text-sm font-semibold text-[#0f172a]">{stage.label}</span>
          <span className="text-xs font-medium text-muted-foreground">{contacts.length}</span>
        </div>
      </div>
      <SortableContext items={contacts.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`flex-1 min-h-[300px] p-2.5 space-y-2 transition-colors ${isOver ? "bg-[#2E37FE]/5" : ""}`}
        >
          {contacts.length === 0 ? (
            <div className={`h-24 rounded-lg border-2 border-dashed flex items-center justify-center text-xs text-muted-foreground ${isOver ? "border-[#2E37FE]/40" : "border-border/50"}`}>
              Drop here
            </div>
          ) : (
            contacts.map((c) => (
              <SortableProspect key={c.id} contact={c} onSelect={() => onSelect(c)} />
            ))
          )}
        </div>
      </SortableContext>
    </div>
  );
}

export default function ProspectsPage() {
  const { organizationId } = useUser();
  const [selected, setSelected] = useState<Contact | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState("");
  const [savingEdits, setSavingEdits] = useState(false);
  const [editNotes, setEditNotes] = useState("");
  const [editFollowUp, setEditFollowUp] = useState<string>("");

  const { data, loading, setData, refetch } = useSupabaseQuery(
    ADMIN_CONTACTS_PIPELINE_KEY,
    fetchAdminContactsPipeline,
  );

  const allContacts = useMemo(() => data ?? [], [data]);
  const inPipeline = useMemo(
    () => allContacts.filter((c): c is Contact & { pipeline_stage: ProspectStage } => c.pipeline_stage !== null),
    [allContacts],
  );

  const byStage = useMemo(() => {
    const map: Record<ProspectStage, Contact[]> = {
      lead: [], contacted: [], meeting: [], proposal: [], closed: [], lost: [],
    };
    for (const c of inPipeline) map[c.pipeline_stage as ProspectStage]?.push(c);
    return map;
  }, [inPipeline]);

  const addableContacts = useMemo(() => {
    const term = contactSearch.trim().toLowerCase();
    return allContacts
      .filter((c) => c.pipeline_stage === null)
      .filter((c) => {
        if (!term) return true;
        const hay = [
          c.first_name, c.last_name, c.email, c.company_name, c.title, industryOf(c),
        ].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(term);
      })
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }, [allContacts, contactSearch]);

  const activeCount = inPipeline.filter((c) => !["closed", "lost"].includes(c.pipeline_stage)).length;
  const closedWon = inPipeline.filter((c) => c.pipeline_stage === "closed").length;
  const overdue = inPipeline.filter(
    (c) =>
      c.pipeline_follow_up_date &&
      new Date(c.pipeline_follow_up_date) < new Date() &&
      !["closed", "lost"].includes(c.pipeline_stage),
  ).length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  async function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    setActiveId(null);
    if (!over) return;

    const activeContact = inPipeline.find((c) => c.id === active.id);
    if (!activeContact) return;

    const overId = String(over.id);
    let targetStage: ProspectStage;
    if (overId.startsWith("column-")) {
      targetStage = overId.replace("column-", "") as ProspectStage;
    } else {
      const overContact = inPipeline.find((c) => c.id === overId);
      if (!overContact) return;
      targetStage = overContact.pipeline_stage;
    }

    const sourceStage = activeContact.pipeline_stage;

    const next = allContacts.slice();
    const fromIdx = next.findIndex((c) => c.id === active.id);
    if (fromIdx < 0) return;

    if (sourceStage === targetStage) {
      const overIdx = next.findIndex((c) => c.id === overId);
      if (overIdx < 0 || fromIdx === overIdx) return;
      const reordered = arrayMove(next, fromIdx, overIdx);
      setData(() => reordered);
      await persistStageAndOrder(reordered, targetStage);
      return;
    }

    const [moving] = next.splice(fromIdx, 1);
    moving.pipeline_stage = targetStage;

    let insertIdx: number;
    if (overId.startsWith("column-")) {
      insertIdx = next.findLastIndex((c) => c.pipeline_stage === targetStage) + 1;
      if (insertIdx === 0) insertIdx = next.length;
    } else {
      insertIdx = next.findIndex((c) => c.id === overId);
      if (insertIdx < 0) insertIdx = next.length;
    }

    next.splice(insertIdx, 0, moving);
    setData(() => next);
    await persistStageAndOrder(next, targetStage, sourceStage);
  }

  async function persistStageAndOrder(
    list: Contact[],
    targetStage: ProspectStage,
    sourceStage?: ProspectStage,
  ) {
    const supabase = createClient();
    const stagesToUpdate = new Set<ProspectStage>([targetStage]);
    if (sourceStage) stagesToUpdate.add(sourceStage);

    for (const stage of stagesToUpdate) {
      const items = list.filter((c) => c.pipeline_stage === stage);
      for (let i = 0; i < items.length; i++) {
        const { error } = await supabase
          .from("contacts")
          .update({ pipeline_stage: stage, pipeline_sort_order: i })
          .eq("id", items[i].id);
        if (error) {
          alert(`Failed to save pipeline change: ${error.message}`);
          void refetch();
          return;
        }
      }
    }
  }

  async function addContactToPipeline(contact: Contact) {
    if (!organizationId) {
      alert("Could not determine organization. Please sign in again.");
      return;
    }
    const supabase = createClient();
    const leadCount = byStage.lead.length;
    const { error } = await supabase
      .from("contacts")
      .update({
        pipeline_stage: "lead",
        pipeline_sort_order: leadCount,
        pipeline_added_at: new Date().toISOString(),
      })
      .eq("id", contact.id);
    if (error) {
      alert(`Failed to add to pipeline: ${error.message}`);
      return;
    }
    setShowAdd(false);
    setContactSearch("");
    void refetch();
  }

  function openDetail(c: Contact) {
    setSelected(c);
    setEditNotes(c.pipeline_notes ?? "");
    setEditFollowUp(c.pipeline_follow_up_date ?? "");
  }

  async function handleSaveProspectEdits() {
    if (!selected) return;
    setSavingEdits(true);
    const supabase = createClient();
    const { error } = await supabase
      .from("contacts")
      .update({
        pipeline_notes: editNotes.trim() || null,
        pipeline_follow_up_date: editFollowUp || null,
      })
      .eq("id", selected.id);
    setSavingEdits(false);
    if (error) {
      alert(`Failed to save: ${error.message}`);
      return;
    }
    setSelected(null);
    void refetch();
  }

  async function handleRemoveFromPipeline(c: Contact) {
    if (
      !confirm(
        `Remove ${c.company_name || displayName(c)} from the pipeline? The contact will remain in Contacts.`,
      )
    )
      return;
    const supabase = createClient();
    const { error } = await supabase
      .from("contacts")
      .update({
        pipeline_stage: null,
        pipeline_sort_order: 0,
        pipeline_notes: null,
        pipeline_follow_up_date: null,
        pipeline_added_at: null,
      })
      .eq("id", c.id);
    if (error) {
      alert(`Failed to remove: ${error.message}`);
      return;
    }
    setSelected(null);
    void refetch();
  }

  const draggingContact = activeId ? inPipeline.find((c) => c.id === activeId) : null;
  const hasAnyContacts = allContacts.length > 0;

  return (
    <div className="space-y-6">
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
            <p className="text-xs font-medium text-[#64748b]">Sales Pipeline</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: "#0f172a", letterSpacing: "-0.01em" }}>
              Prospects
            </h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {inPipeline.length} in pipeline · {activeCount} active · {closedWon} won
            </p>
          </div>
          <Button
            onClick={() => setShowAdd(true)}
            className="bg-white/15 hover:bg-white/25 text-[#0f172a] border-0"
          >
            <Plus size={16} className="mr-1" />
            Add to Pipeline
          </Button>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Active Pipeline"
          value={activeCount}
          icon={<Target size={18} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Closed Won"
          value={closedWon}
          icon={<CheckCircle size={18} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
          valueColor="text-emerald-600"
        />
        <StatCard
          label="Overdue Follow-ups"
          value={overdue}
          icon={<Calendar size={18} className="text-red-500" />}
          iconBg="bg-red-50"
          valueColor={overdue > 0 ? "text-red-600" : undefined}
        />
      </div>

      {loading ? (
        <div className="flex gap-4 overflow-x-auto pb-2">
          {STAGES.map((s) => (
            <div key={s.value} className="w-[280px] shrink-0 rounded-xl bg-muted/40 h-80 animate-pulse" />
          ))}
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex gap-4 overflow-x-auto pb-4">
            {STAGES.map((stage) => (
              <KanbanColumn
                key={stage.value}
                stage={stage}
                contacts={byStage[stage.value]}
                onSelect={openDetail}
              />
            ))}
          </div>
          <DragOverlay>
            {draggingContact ? (
              <div className="w-[260px]">
                <ProspectCardInner contact={draggingContact} dragging />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Detail dialog — pipeline-only edits; contact info read-only */}
      {selected && (
        <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white"
                  style={{ background: "#2E37FE" }}
                >
                  {(selected.company_name || selected.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="truncate">{selected.company_name || displayName(selected)}</div>
                  <div className="text-xs font-normal text-muted-foreground truncate">
                    {displayName(selected)}
                  </div>
                </div>
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 mt-2">
              {selected.pipeline_stage && (
                <div className="flex items-center gap-2">
                  <Badge
                    variant="secondary"
                    className={`border ${stageDef(selected.pipeline_stage).badge} ${stageDef(selected.pipeline_stage).badgeBorder}`}
                  >
                    {stageDef(selected.pipeline_stage).label}
                  </Badge>
                  {industryOf(selected) && (
                    <Badge variant="outline" className="text-muted-foreground">
                      {industryOf(selected)}
                    </Badge>
                  )}
                </div>
              )}

              <div className="rounded-xl border border-border/50 p-4 space-y-2 bg-muted/20">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                    <Lock size={11} /> Contact info (read-only)
                  </p>
                  <Link
                    href="/admin/contacts"
                    className="text-xs font-medium text-[#2E37FE] hover:underline flex items-center gap-1"
                  >
                    View contact <ExternalLink size={11} />
                  </Link>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Users size={14} className="text-muted-foreground" />
                  <span className="font-medium">{displayName(selected)}</span>
                  {selected.title && (
                    <span className="text-xs text-muted-foreground">· {selected.title}</span>
                  )}
                </div>
                {selected.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail size={14} className="text-muted-foreground" />
                    <span>{selected.email}</span>
                  </div>
                )}
                {selected.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone size={14} className="text-muted-foreground" />
                    <span>{selected.phone}</span>
                  </div>
                )}
                {websiteOf(selected) && (
                  <div className="flex items-center gap-2 text-sm">
                    <Globe size={14} className="text-muted-foreground" />
                    <span>{websiteOf(selected)}</span>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground pt-1">
                  To change name, email, company, or phone, edit the contact profile.
                </p>
              </div>

              <div className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Deal details
                </p>
                <div className="space-y-1">
                  <Label className="text-sm">Deal notes</Label>
                  <Textarea
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    rows={3}
                    placeholder="Notes about this deal..."
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-sm">Follow-up date</Label>
                  <Input
                    type="date"
                    value={editFollowUp}
                    onChange={(e) => setEditFollowUp(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-border/30">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-600 hover:text-red-700 hover:bg-red-50"
                  onClick={() => handleRemoveFromPipeline(selected)}
                >
                  <Trash2 size={14} className="mr-1" />
                  Remove from pipeline
                </Button>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSelected(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    style={{ background: "#2E37FE" }}
                    disabled={savingEdits}
                    onClick={handleSaveProspectEdits}
                  >
                    {savingEdits ? "Saving..." : "Save changes"}
                  </Button>
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Add-to-pipeline dialog */}
      <Dialog open={showAdd} onOpenChange={(v) => { setShowAdd(v); if (!v) setContactSearch(""); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add contact to pipeline</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            {!hasAnyContacts ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center space-y-3">
                <UserPlus size={28} className="mx-auto text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">No contacts yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Create a contact first — they&apos;re the source of truth for name, email, and company.
                  </p>
                </div>
                <Link href="/admin/contacts">
                  <Button style={{ background: "#2E37FE" }} onClick={() => setShowAdd(false)}>
                    Go to Contacts
                  </Button>
                </Link>
              </div>
            ) : addableContacts.length === 0 && contactSearch.trim() === "" ? (
              <div className="rounded-xl border border-dashed border-border p-6 text-center space-y-3">
                <CheckCircle size={28} className="mx-auto text-emerald-500" />
                <div>
                  <p className="text-sm font-medium">Every contact is already in the pipeline</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Add a new contact in Contacts first, then come back here.
                  </p>
                </div>
                <Link href="/admin/contacts">
                  <Button variant="outline" onClick={() => setShowAdd(false)}>
                    Go to Contacts
                  </Button>
                </Link>
              </div>
            ) : (
              <>
                <div className="relative">
                  <Search
                    size={14}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                  />
                  <Input
                    className="pl-9"
                    placeholder="Search contacts by name, email, or company..."
                    value={contactSearch}
                    onChange={(e) => setContactSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                <div className="max-h-[360px] overflow-y-auto rounded-xl border border-border/50 divide-y divide-border/50">
                  {addableContacts.length === 0 ? (
                    <p className="p-4 text-sm text-muted-foreground text-center">
                      No matching contacts.
                    </p>
                  ) : (
                    addableContacts.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => addContactToPipeline(c)}
                        className="w-full flex items-center gap-3 p-3 hover:bg-muted/40 transition-colors text-left"
                      >
                        <div
                          className="flex h-9 w-9 items-center justify-center rounded-lg text-xs font-bold text-white shrink-0"
                          style={{ background: "#2E37FE" }}
                        >
                          {(c.company_name || c.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">
                            {c.company_name || displayName(c)}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {displayName(c)} · {c.email}
                          </p>
                        </div>
                        <Plus size={16} className="text-[#2E37FE] shrink-0" />
                      </button>
                    ))
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Don&apos;t see them?{" "}
                  <Link href="/admin/contacts" className="text-[#2E37FE] hover:underline">
                    Create a contact
                  </Link>{" "}
                  first.
                </p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
