"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { StatCard } from "@/components/charts/stat-card";
import {
  Target,
  Plus,
  Phone,
  Mail,
  Globe,
  Calendar,
  Building2,
  Users,
  CheckCircle,
  XCircle,
  ArrowRight,
} from "lucide-react";
import type { Prospect, ProspectStage } from "@/types/app";

const STAGES: { value: ProspectStage; label: string; color: string; borderColor: string }[] = [
  { value: "lead", label: "Lead", color: "bg-[#e2e8f0] text-[#B8B5AE]", borderColor: "border-gray-200" },
  { value: "contacted", label: "Contacted", color: "badge-blue", borderColor: "border-blue-200" },
  { value: "meeting", label: "Meeting", color: "bg-[#2E37FE]/20 text-[#6B72FF]", borderColor: "border-[#2E37FE]/20" },
  { value: "proposal", label: "Proposal", color: "badge-amber", borderColor: "border-amber-200" },
  { value: "closed", label: "Closed Won", color: "badge-green", borderColor: "border-emerald-200" },
  { value: "lost", label: "Lost", color: "badge-red", borderColor: "border-red-200" },
];

function getStageConfig(stage: ProspectStage) {
  return STAGES.find((s) => s.value === stage) || STAGES[0];
}

function ProspectCard({ prospect, onSelect }: { prospect: Prospect; onSelect: () => void }) {
  const stage = getStageConfig(prospect.stage);
  const isOverdue = prospect.follow_up_date && new Date(prospect.follow_up_date) < new Date() && !["closed", "lost"].includes(prospect.stage);

  return (
    <Card
      onClick={onSelect}
      className="group cursor-pointer transition-all hover:border-[#2E37FE]/30 hover:shadow-md"
    >
    <CardContent className="p-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-white shrink-0" style={{ background: '#2E37FE' }}>
            {prospect.company_name.charAt(0)}
          </div>
          <div>
            <p className="font-semibold text-foreground">{prospect.company_name}</p>
            <p className="text-xs text-muted-foreground">{prospect.contact_name || "No contact"}</p>
          </div>
        </div>
        <ArrowRight size={14} className="text-muted-foreground mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Badge variant="secondary" className={`text-xs border ${stage.color} ${stage.borderColor}`}>
          {stage.label}
        </Badge>
        {prospect.industry && (
          <Badge variant="outline" className="text-xs text-muted-foreground">
            {prospect.industry}
          </Badge>
        )}
        {isOverdue && (
          <Badge variant="secondary" className="text-xs badge-red">
            Overdue
          </Badge>
        )}
      </div>

      {prospect.deal_notes && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-2">{prospect.deal_notes}</p>
      )}

      <div className="flex items-center gap-4 pt-2 border-t border-border/30 text-xs text-muted-foreground">
        {prospect.contact_email && (
          <span className="flex items-center gap-1">
            <Mail size={11} /> {prospect.contact_email}
          </span>
        )}
        {prospect.follow_up_date && (
          <span className="flex items-center gap-1 ml-auto">
            <Calendar size={11} />
            {new Date(prospect.follow_up_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
    </CardContent>
    </Card>
  );
}

export default function ProspectsPage() {
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [filter, setFilter] = useState<ProspectStage | "all">("all");
  const [selected, setSelected] = useState<Prospect | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // Add form state
  const [newCompany, setNewCompany] = useState("");
  const [newContact, setNewContact] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newIndustry, setNewIndustry] = useState("");
  const [newNotes, setNewNotes] = useState("");

  useEffect(() => {
    const supabase = createClient();
    supabase.from("prospects").select("*").order("updated_at", { ascending: false }).then(({ data }: { data: unknown }) => {
      setProspects((data || []) as Prospect[]);
    });
  }, []);

  const filtered = filter === "all" ? prospects : prospects.filter((p) => p.stage === filter);

  const stageCounts = STAGES.reduce<Record<string, number>>((acc, s) => {
    acc[s.value] = prospects.filter((p) => p.stage === s.value).length;
    return acc;
  }, {});

  const activeProspects = prospects.filter((p) => !["closed", "lost"].includes(p.stage)).length;
  const closedWon = prospects.filter((p) => p.stage === "closed").length;
  const overdue = prospects.filter((p) => p.follow_up_date && new Date(p.follow_up_date) < new Date() && !["closed", "lost"].includes(p.stage)).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]" style={{ background: 'linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)', border: '1px solid rgba(46,55,254,0.2)', borderTop: '1px solid rgba(46,55,254,0.3)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)' }}>
        <div className="relative z-10 flex items-start justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">Sales Pipeline</p>
            <h1 className="text-[20px] sm:text-[22px] font-bold mt-1" style={{ color: '#0f172a', letterSpacing: '-0.01em' }}>Prospects</h1>
            <p className="text-sm text-[#0f172a]/60 mt-1">
              {prospects.length} total &middot; {activeProspects} active &middot; {closedWon} won
            </p>
          </div>
          <Button
            onClick={() => setShowAdd(true)}
            className="bg-white/15 hover:bg-white/25 text-[#0f172a] border-0"
          >
            <Plus size={16} className="mr-1" />
            Add Prospect
          </Button>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          label="Active Pipeline"
          value={activeProspects}
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

      {/* Stage filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilter("all")}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            filter === "all"
              ? "bg-[#2E37FE] text-[#0f172a]"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
        >
          All ({prospects.length})
        </button>
        {STAGES.map((s) => (
          <button
            key={s.value}
            onClick={() => setFilter(s.value)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors border ${
              filter === s.value
                ? `${s.color} ${s.borderColor}`
                : "bg-muted text-muted-foreground hover:bg-muted/80 border-transparent"
            }`}
          >
            {s.label} ({stageCounts[s.value] || 0})
          </button>
        ))}
      </div>

      {/* Prospect cards grid */}
      {filtered.length === 0 ? (
        <Card className="border-border/50 shadow-sm">
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground font-medium">No prospects in this stage</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((prospect) => (
            <ProspectCard
              key={prospect.id}
              prospect={prospect}
              onSelect={() => setSelected(prospect)}
            />
          ))}
        </div>
      )}

      {/* Prospect Detail Dialog */}
      {selected && (
        <Dialog open={!!selected} onOpenChange={() => setSelected(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg text-sm font-bold text-[#0f172a]" style={{ background: '#2E37FE' }}>
                  {selected.company_name.charAt(0)}
                </div>
                {selected.company_name}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              {/* Stage */}
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className={`border ${getStageConfig(selected.stage).color} ${getStageConfig(selected.stage).borderColor}`}>
                  {getStageConfig(selected.stage).label}
                </Badge>
                {selected.industry && (
                  <Badge variant="outline" className="text-muted-foreground">{selected.industry}</Badge>
                )}
              </div>

              {/* Contact info */}
              <div className="space-y-2 rounded-xl border border-border/50 p-4">
                {selected.contact_name && (
                  <div className="flex items-center gap-2 text-sm">
                    <Users size={14} className="text-muted-foreground" />
                    <span className="font-medium">{selected.contact_name}</span>
                  </div>
                )}
                {selected.contact_email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail size={14} className="text-muted-foreground" />
                    <span>{selected.contact_email}</span>
                  </div>
                )}
                {selected.contact_phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone size={14} className="text-muted-foreground" />
                    <span>{selected.contact_phone}</span>
                  </div>
                )}
                {selected.website && (
                  <div className="flex items-center gap-2 text-sm">
                    <Globe size={14} className="text-muted-foreground" />
                    <span>{selected.website}</span>
                  </div>
                )}
              </div>

              {/* Notes */}
              {selected.deal_notes && (
                <div className="space-y-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</p>
                  <p className="text-sm text-foreground bg-muted/30 rounded-lg p-3">{selected.deal_notes}</p>
                </div>
              )}

              {/* Follow-up */}
              {selected.follow_up_date && (
                <div className="flex items-center gap-2 text-sm">
                  <Calendar size={14} className="text-muted-foreground" />
                  <span>Follow-up: {new Date(selected.follow_up_date).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</span>
                </div>
              )}

              {/* Timestamps */}
              <div className="text-xs text-muted-foreground pt-2 border-t border-border/30">
                Created {new Date(selected.created_at).toLocaleDateString()} &middot; Updated {new Date(selected.updated_at).toLocaleDateString()}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Add Prospect Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Prospect</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Company Name *</Label>
                <Input value={newCompany} onChange={(e) => setNewCompany(e.target.value)} placeholder="Company name" />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Contact Name</Label>
                <Input value={newContact} onChange={(e) => setNewContact(e.target.value)} placeholder="Full name" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-sm font-medium">Email</Label>
                <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="email@company.com" />
              </div>
              <div className="space-y-1">
                <Label className="text-sm font-medium">Phone</Label>
                <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="(555) 000-0000" />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Industry</Label>
              <Input value={newIndustry} onChange={(e) => setNewIndustry(e.target.value)} placeholder="e.g. Real Estate, SaaS, Legal" />
            </div>
            <div className="space-y-1">
              <Label className="text-sm font-medium">Notes</Label>
              <Textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} placeholder="How did you find them? What do they need?" rows={3} />
            </div>
            <Button
              className="w-full"
              style={{ background: '#2E37FE' }}
              disabled={!newCompany.trim()}
              onClick={() => {
                // In demo mode, just close — real mode would insert to Supabase
                setShowAdd(false);
                setNewCompany("");
                setNewContact("");
                setNewEmail("");
                setNewPhone("");
                setNewIndustry("");
                setNewNotes("");
              }}
            >
              Add Prospect
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
