"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { appUrl } from "@/lib/api-url";
import { QuoteLayout } from "@/components/billing/quote-layout";
import type {
  PricingPlan,
  Quote,
  QuoteStatus,
  SubscriptionStatus,
  InvoiceStatus,
  Client,
  ClientSubscription,
  BillingInvoice,
} from "@/types/app";
import {
  CreditCard,
  DollarSign,
  Users,
  TrendingUp,
  CheckCircle,
  FileText,
  Receipt,
  Layers,
  ExternalLink,
  Pencil,
  Plus,
  X,
  MoreHorizontal,
  Pause,
  Play,
  RotateCcw,
  Ban,
} from "lucide-react";
import { StatCard } from "@/components/charts/stat-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ---------- helpers ----------
function formatCents(cents: number): string {
  const dollars = cents / 100;
  return dollars % 1 === 0
    ? `$${dollars.toLocaleString()}`
    : `$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function centsToDollarInput(cents: number): string {
  return (cents / 100).toString();
}

function dollarInputToCents(input: string): number {
  const n = parseFloat(input);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function clientName(clientId: string, clients: Client[]): string {
  return clients.find((c) => c.id === clientId)?.name ?? "Unknown";
}

function planName(planId: string | null, plans: PricingPlan[]): string {
  if (!planId) return "Custom";
  return plans.find((p) => p.id === planId)?.name ?? "Unknown";
}

// ---------- status badges ----------
function SubStatusBadge({ status }: { status: SubscriptionStatus }) {
  const styles: Record<SubscriptionStatus, string> = {
    active: "badge-green",
    trialing: "badge-blue",
    past_due: "badge-red",
    canceled: "badge-slate",
    incomplete: "badge-amber",
    paused: "badge-slate",
  };
  const labels: Record<SubscriptionStatus, string> = {
    active: "active",
    trialing: "warming",
    past_due: "past due",
    canceled: "canceled",
    incomplete: "incomplete",
    paused: "paused",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {labels[status] || status.replace("_", " ")}
    </Badge>
  );
}

function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const styles: Record<InvoiceStatus, string> = {
    paid: "badge-green",
    open: "badge-amber",
    uncollectible: "badge-red",
    void: "badge-slate",
    draft: "badge-slate",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {status}
    </Badge>
  );
}

function QuoteStatusBadge({ status }: { status: QuoteStatus }) {
  const styles: Record<QuoteStatus, string> = {
    accepted: "badge-green",
    sent: "badge-blue",
    viewed: "badge-blue",
    draft: "badge-slate",
    declined: "badge-red",
    expired: "badge-slate",
    canceled: "badge-slate",
  };
  return (
    <Badge variant="secondary" className={styles[status] || ""}>
      {status}
    </Badge>
  );
}

// ---------- Plan edit/create dialog ----------
export interface PlanFormInput {
  name: string;
  description: string | null;
  monthly_price_cents: number;
  features: string[];
  scope_template: string | null;
  active: boolean;
}

function PlanEditDialog({
  plan,
  open,
  mode,
  onOpenChange,
  onSave,
  onCreate,
}: {
  plan: PricingPlan | null;
  open: boolean;
  mode: "edit" | "create";
  onOpenChange: (open: boolean) => void;
  onSave: (id: string, updates: Partial<PricingPlan>) => Promise<void>;
  onCreate: (input: PlanFormInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [monthlyDollars, setMonthlyDollars] = useState("0");
  const [features, setFeatures] = useState<string[]>([]);
  const [scopeTemplate, setScopeTemplate] = useState("");
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && plan) {
      setName(plan.name);
      setDescription(plan.description ?? "");
      setMonthlyDollars(centsToDollarInput(plan.monthly_price_cents));
      setFeatures([...plan.features]);
      setScopeTemplate(plan.scope_template ?? "");
      setActive(plan.active);
    } else if (mode === "create") {
      setName("");
      setDescription("");
      setMonthlyDollars("0");
      setFeatures([]);
      setScopeTemplate("");
      setActive(true);
    }
  }, [plan, mode, open]);

  async function handleSave() {
    const payload: PlanFormInput = {
      name,
      description: description || null,
      monthly_price_cents: dollarInputToCents(monthlyDollars),
      features: features.filter((f) => f.trim().length > 0),
      scope_template: scopeTemplate || null,
      active,
    };
    setSaving(true);
    try {
      if (mode === "edit" && plan) {
        await onSave(plan.id, payload);
      } else {
        await onCreate(payload);
      }
    } finally {
      setSaving(false);
    }
  }

  if (mode === "edit" && !plan) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit" && plan
              ? `Edit plan: ${plan.name}`
              : "New plan"}
          </DialogTitle>
          <DialogDescription>
            {mode === "edit"
              ? "Changes save to the database and sync to Stripe as an updated Product + Price."
              : "Creates a new plan and a matching Stripe Product + recurring Price on save."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pb-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="plan-name">Name</Label>
              <Input
                id="plan-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-price">Monthly price (USD)</Label>
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  id="plan-price"
                  type="number"
                  min="0"
                  step="0.01"
                  className="pl-6"
                  value={monthlyDollars}
                  onChange={(e) => setMonthlyDollars(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-desc">Short description</Label>
            <Input
              id="plan-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Shown below the plan name in the client quote."
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Features</Label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="text-xs"
                onClick={() => setFeatures([...features, ""])}
              >
                <Plus size={12} className="mr-1" />
                Add feature
              </Button>
            </div>
            <div className="space-y-2">
              {features.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No features yet. Click <strong>Add feature</strong>.
                </p>
              )}
              {features.map((feat, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={feat}
                    onChange={(e) => {
                      const next = [...features];
                      next[idx] = e.target.value;
                      setFeatures(next);
                    }}
                    placeholder={`Feature ${idx + 1}`}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() =>
                      setFeatures(features.filter((_, i) => i !== idx))
                    }
                  >
                    <X size={14} />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="plan-scope">Scope template (pre-fills new quotes)</Label>
            <Textarea
              id="plan-scope"
              value={scopeTemplate}
              onChange={(e) => setScopeTemplate(e.target.value)}
              rows={4}
              placeholder="One scope item per line. Used as the default Scope of Work on new quotes."
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              id="plan-active"
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4 rounded border-input accent-[#2E37FE]"
            />
            <Label htmlFor="plan-active" className="cursor-pointer">
              Active (available on new quotes)
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !name.trim()}
            style={{ background: "#2E37FE" }}
          >
            {saving
              ? "Saving…"
              : mode === "edit"
                ? "Save changes"
                : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- New quote dialog ----------
type QuoteDraft = {
  client_id: string;
  plan_id: string | null;
  plan_name_snapshot: string;
  monthly_price_cents: number;
  setup_fee_cents: number;
  currency: string;
  scope_of_work: string;
  terms: string;
  sent_to_email: string;
  expires_at: string;
};

const DEFAULT_TERMS =
  "Auto-charged monthly via Stripe after the 14-day warming period. Net 0.";

function defaultExpiry(): string {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];
}

// ---------- New quote dialog ----------
function NewQuoteDialog({
  open,
  onOpenChange,
  onCreate,
  clients,
  plans,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: QuoteDraft, sendNow: boolean) => Promise<void>;
  clients: Client[];
  plans: PricingPlan[];
}) {
  const [contactId, setContactId] = useState<string>("");
  const [planId, setPlanId] = useState<string>("custom");
  const [planNameSnapshot, setPlanNameSnapshot] = useState("");
  const [monthlyDollars, setMonthlyDollars] = useState("0");
  const [setupDollars, setSetupDollars] = useState("0");
  const [scope, setScope] = useState("");
  const [terms, setTerms] = useState(DEFAULT_TERMS);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [expiresAt, setExpiresAt] = useState(defaultExpiry());
  const [submitting, setSubmitting] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setContactId("");
      setPlanId("custom");
      setPlanNameSnapshot("Custom");
      setMonthlyDollars("0");
      setSetupDollars("0");
      setScope("");
      setTerms(DEFAULT_TERMS);
      setRecipientEmail("");
      setExpiresAt(defaultExpiry());
      setPreviewMode(false);
    }
  }, [open]);

  function handleContactChange(id: string) {
    setContactId(id);
    const c = clients.find((cl) => cl.id === id);
    if (c?.contact_email) setRecipientEmail(c.contact_email);
  }

  function handlePlanChange(id: string) {
    setPlanId(id);
    if (id === "custom") {
      setPlanNameSnapshot("Custom");
      return;
    }
    const p = plans.find((pl) => pl.id === id);
    if (p) {
      setPlanNameSnapshot(p.name);
      setMonthlyDollars(centsToDollarInput(p.monthly_price_cents));
      if (p.scope_template) setScope(p.scope_template);
    }
  }

  async function handleSubmit(sendNow: boolean) {
    if (!contactId) return;
    setSubmitting(true);
    try {
      await onCreate(
        {
          client_id: contactId,
          plan_id: planId === "custom" ? null : planId,
          plan_name_snapshot: planNameSnapshot || "Custom",
          monthly_price_cents: dollarInputToCents(monthlyDollars),
          setup_fee_cents: dollarInputToCents(setupDollars),
          currency: "usd",
          scope_of_work: scope,
          terms: terms,
          sent_to_email: recipientEmail,
          expires_at: new Date(expiresAt).toISOString(),
        },
        sendNow,
      );
    } finally {
      setSubmitting(false);
    }
  }

  const canSubmit = contactId.length > 0 && planNameSnapshot.trim().length > 0;
  const canSend = canSubmit && recipientEmail.trim().length > 0;
  const selectedContact = clients.find((c) => c.id === contactId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:w-[92vw] max-w-2xl max-h-[90vh] overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>
            {previewMode ? "Preview quote" : "New quote"}
          </DialogTitle>
          <DialogDescription>
            {previewMode
              ? "This is exactly what the recipient will see at their signed URL."
              : "Formal proposal for a contact. Save as a draft to keep editing, or send to email the signed URL."}
          </DialogDescription>
        </DialogHeader>

        {previewMode ? (
          <QuoteLayout
            quoteNumber={`Q-${new Date().getFullYear()}-NEW`}
            isDraft
            contactName={selectedContact?.name || "(no contact selected)"}
            contactEmail={recipientEmail}
            planNameSnapshot={planNameSnapshot}
            monthlyCents={dollarInputToCents(monthlyDollars)}
            setupCents={dollarInputToCents(setupDollars)}
            scope={scope}
            terms={terms}
            expiresAt={expiresAt}
            trailingSlot={
              <div className="rounded-xl border border-dashed border-[#2E37FE]/30 bg-[#2E37FE]/5 p-4 text-xs text-muted-foreground">
                Once sent, the recipient sees this exact layout at a signed URL
                with an <strong>Accept &amp; pay</strong> button that opens
                Stripe Checkout.
              </div>
            }
          />
        ) : (
          <div className="space-y-4 pb-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Contact</Label>
                <Select value={contactId} onValueChange={handleContactChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a contact" />
                  </SelectTrigger>
                  <SelectContent>
                    {clients.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Plan</Label>
                <Select value={planId} onValueChange={handlePlanChange}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Pick a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {plans
                      .filter((p) => p.active)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} — {formatCents(p.monthly_price_cents)}/mo
                        </SelectItem>
                      ))}
                    <SelectItem value="custom">Custom (no template)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-plan-name">Plan name on quote</Label>
              <Input
                id="q-plan-name"
                value={planNameSnapshot}
                onChange={(e) => setPlanNameSnapshot(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="q-monthly">Monthly (USD)</Label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="q-monthly"
                    type="number"
                    min="0"
                    step="0.01"
                    className="pl-6"
                    value={monthlyDollars}
                    onChange={(e) => setMonthlyDollars(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-setup">Setup fee (USD)</Label>
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="q-setup"
                    type="number"
                    min="0"
                    step="0.01"
                    className="pl-6"
                    value={setupDollars}
                    onChange={(e) => setSetupDollars(e.target.value)}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-scope">Scope of work</Label>
              <Textarea
                id="q-scope"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                rows={4}
                placeholder="One scope item per line."
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="q-terms">Terms</Label>
              <Textarea
                id="q-terms"
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                rows={2}
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="q-email">Send to email</Label>
                <Input
                  id="q-email"
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                  placeholder="Auto-fills from selected contact"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="q-expires">Quote expires</Label>
                <Input
                  id="q-expires"
                  type="date"
                  value={expiresAt}
                  onChange={(e) => setExpiresAt(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2 flex-col sm:flex-row">
          {previewMode ? (
            <Button
              variant="outline"
              onClick={() => setPreviewMode(false)}
              disabled={submitting}
              className="w-full sm:w-auto"
            >
              ← Back to edit
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={() => setPreviewMode(true)}
                disabled={!canSubmit}
                className="w-full sm:w-auto"
              >
                View draft
              </Button>
            </>
          )}
          <Button
            variant="outline"
            onClick={() => handleSubmit(false)}
            disabled={submitting || !canSubmit}
            className="w-full sm:w-auto"
          >
            Save as draft
          </Button>
          <Button
            onClick={() => handleSubmit(true)}
            disabled={submitting || !canSend}
            style={{ background: "#2E37FE" }}
            className="w-full sm:w-auto"
          >
            {submitting ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------- Page ----------
export default function BillingPage() {
  const [plans, setPlans] = useState<PricingPlan[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [subscriptions, setSubscriptions] = useState<ClientSubscription[]>([]);
  const [invoices, setInvoices] = useState<BillingInvoice[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [stripeMode, setStripeMode] = useState<"demo" | "live" | "test">(
    "demo",
  );
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingPlan, setEditingPlan] = useState<PricingPlan | null>(null);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [newQuoteOpen, setNewQuoteOpen] = useState(false);
  const [cancelingSub, setCancelingSub] = useState<ClientSubscription | null>(
    null,
  );
  const [cancelNowSub, setCancelNowSub] = useState<ClientSubscription | null>(
    null,
  );
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [rowActionLoading, setRowActionLoading] = useState<string | null>(null);
  const [portalSentFor, setPortalSentFor] = useState<string | null>(null);
  const [portalSending, setPortalSending] = useState<string | null>(null);
  const [portalUrlDialog, setPortalUrlDialog] = useState<{
    clientName: string;
    url: string;
    reason: "no_email" | "manual_copy";
  } | null>(null);
  const [selectedTab, setSelectedTab] = useState<string>("subscriptions");

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const res = await fetch(appUrl("/api/billing/data"));
        if (!res.ok) {
          const { error } = await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }));
          throw new Error(error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          plans: PricingPlan[];
          quotes: Quote[];
          subscriptions: ClientSubscription[];
          invoices: BillingInvoice[];
          clients: Client[];
          stripe_mode?: "demo" | "live" | "test";
        };
        if (canceled) return;
        setPlans(data.plans);
        setQuotes(data.quotes);
        setSubscriptions(data.subscriptions);
        setInvoices(data.invoices);
        setClients(data.clients);
        if (data.stripe_mode) setStripeMode(data.stripe_mode);
      } catch (err) {
        if (canceled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!canceled) setLoading(false);
      }
    })();
    return () => {
      canceled = true;
    };
  }, []);

  async function savePlan(id: string, updates: Partial<PricingPlan>) {
    const res = await fetch(appUrl(`/api/billing/plans/${id}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "save failed" }));
      throw new Error(error);
    }
    const { plan: updated } = (await res.json()) as { plan: PricingPlan };
    setPlans((prev) =>
      prev.map((p) => (p.id === id ? { ...p, ...updated } : p)),
    );
    setEditingPlan(null);
  }

  async function createPlan(input: PlanFormInput) {
    const res = await fetch(appUrl("/api/billing/plans"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const { error } = await res
        .json()
        .catch(() => ({ error: "create failed" }));
      throw new Error(error);
    }
    const { plan: created } = (await res.json()) as { plan: PricingPlan };
    setPlans((prev) => [...prev, created]);
    setCreatingPlan(false);
  }

  async function handleSendPortal(clientId: string, emailIt: boolean) {
    setPortalSending(clientId);
    try {
      const res = await fetch(appUrl("/api/billing/portal"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, email: emailIt }),
      });
      if (!res.ok) {
        const { error } = await res
          .json()
          .catch(() => ({ error: "Portal failed" }));
        throw new Error(error);
      }
      const { portal_url: portalUrl, emailed } = (await res.json()) as {
        portal_url: string;
        emailed: boolean;
      };
      if (emailed) {
        setPortalSentFor(clientId);
        setTimeout(() => setPortalSentFor(null), 2500);
      } else {
        setPortalUrlDialog({
          clientName: clientName(clientId, clients),
          url: portalUrl,
          reason: emailIt ? "no_email" : "manual_copy",
        });
      }
    } finally {
      setPortalSending(null);
    }
  }

  async function handleCancelSub(subId: string) {
    setCancelSubmitting(true);
    try {
      const res = await fetch(
        appUrl(`/api/billing/subscriptions/${subId}/cancel`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "cancel failed" }));
        throw new Error(error);
      }
      setSubscriptions((prev) =>
        prev.map((s) =>
          s.id === subId ? { ...s, cancel_at_period_end: true } : s,
        ),
      );
      setCancelingSub(null);
    } finally {
      setCancelSubmitting(false);
    }
  }

  async function handleUncancelSub(subId: string) {
    setRowActionLoading(subId);
    try {
      const res = await fetch(
        appUrl(`/api/billing/subscriptions/${subId}/uncancel`),
        { method: "POST" },
      );
      if (!res.ok) {
        const { error } = await res
          .json()
          .catch(() => ({ error: "un-cancel failed" }));
        alert(`Could not un-cancel: ${error}`);
        return;
      }
      setSubscriptions((prev) =>
        prev.map((s) =>
          s.id === subId ? { ...s, cancel_at_period_end: false } : s,
        ),
      );
    } finally {
      setRowActionLoading(null);
    }
  }

  async function handleCancelNow(subId: string) {
    setCancelSubmitting(true);
    try {
      const res = await fetch(
        appUrl(`/api/billing/subscriptions/${subId}/cancel-now`),
        { method: "POST" },
      );
      if (!res.ok) {
        const { error } = await res
          .json()
          .catch(() => ({ error: "cancel failed" }));
        alert(`Could not cancel: ${error}`);
        return;
      }
      setSubscriptions((prev) =>
        prev.map((s) =>
          s.id === subId
            ? {
                ...s,
                status: "canceled",
                cancel_at_period_end: false,
                canceled_at: new Date().toISOString(),
              }
            : s,
        ),
      );
      setCancelNowSub(null);
    } finally {
      setCancelSubmitting(false);
    }
  }

  async function handlePauseResume(
    subId: string,
    action: "pause" | "resume",
  ) {
    setRowActionLoading(subId);
    try {
      const res = await fetch(
        appUrl(`/api/billing/subscriptions/${subId}/pause`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      if (!res.ok) {
        const { error } = await res
          .json()
          .catch(() => ({ error: `${action} failed` }));
        alert(`Could not ${action}: ${error}`);
        return;
      }
      setSubscriptions((prev) =>
        prev.map((s) =>
          s.id === subId
            ? { ...s, status: action === "pause" ? "paused" : "active" }
            : s,
        ),
      );
    } finally {
      setRowActionLoading(null);
    }
  }

  async function createQuote(draft: QuoteDraft, sendNow: boolean) {
    const res = await fetch(appUrl("/api/billing/quotes"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...draft,
        send_now: sendNow,
      }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "save failed" }));
      throw new Error(error);
    }
    const { quote } = (await res.json()) as { quote: Quote };
    setQuotes((prev) => [quote, ...prev]);
    setNewQuoteOpen(false);
    setSelectedTab("quotes");
  }

  // KPIs
  const mrrCents = subscriptions
    .filter((s) => s.status === "active" || s.status === "trialing")
    .reduce((sum, s) => {
      const plan = plans.find((p) => p.id === s.plan_id);
      return sum + (plan?.monthly_price_cents ?? 0);
    }, 0);

  const activeCount = subscriptions.filter((s) => s.status === "active").length;
  const warmingCount = subscriptions.filter(
    (s) => s.status === "trialing",
  ).length;
  const totalCollectedCents = invoices
    .filter((i) => i.status === "paid")
    .reduce((sum, i) => sum + i.amount_paid_cents, 0);

  const pendingQuotesCount = quotes.filter(
    (q) => q.status === "sent" || q.status === "viewed",
  ).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
          borderTop: "1px solid rgba(46,55,254,0.3)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.9), 0 4px 14px rgba(46,55,254,0.1)",
        }}
      >
        <div className="relative z-10 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-[#64748b]">
              Revenue & Billing
            </p>
            <h1
              className="text-[20px] sm:text-[22px] font-bold mt-1"
              style={{ color: "#0f172a", letterSpacing: "-0.01em" }}
            >
              Billing & Subscriptions
            </h1>
          </div>
          <Badge
            variant="secondary"
            className={
              stripeMode === "live"
                ? "bg-emerald-100 text-emerald-700 border-0"
                : stripeMode === "test"
                  ? "bg-amber-100 text-amber-700 border-0"
                  : "bg-white/15 text-[#0f172a] border-0"
            }
          >
            {stripeMode === "live"
              ? "Stripe: Live"
              : stripeMode === "test"
                ? "Stripe: Test"
                : "Stripe: Demo"}
          </Badge>
        </div>
        <div className="absolute -top-10 -right-10 h-40 w-40 rounded-full bg-[rgba(107,114,255,0.06)]" />
      </div>

      {loading && (
        <p className="text-sm text-muted-foreground">Loading billing data…</p>
      )}
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          Failed to load billing data: {loadError}
        </div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Monthly Revenue"
          value={formatCents(mrrCents)}
          icon={<DollarSign size={18} className="text-emerald-500" />}
          iconBg="bg-emerald-50"
          valueColor="text-emerald-600"
        />
        <StatCard
          label="Active Subs"
          value={activeCount}
          icon={<Users size={18} className="text-[#2E37FE]" />}
          iconBg="bg-[#2E37FE]/10"
        />
        <StatCard
          label="Warming"
          value={warmingCount}
          icon={<TrendingUp size={18} className="text-blue-500" />}
          iconBg="bg-blue-50"
          valueColor="text-blue-600"
        />
        <StatCard
          label="Total Collected"
          value={formatCents(totalCollectedCents)}
          icon={<CreditCard size={18} className="text-amber-500" />}
          iconBg="bg-amber-50"
        />
      </div>

      {/* Tabs */}
      <Tabs value={selectedTab} onValueChange={setSelectedTab}>
        <TabsList>
          <TabsTrigger value="plans">
            <Layers size={14} />
            Plans
            <span className="ml-1 text-xs text-muted-foreground">
              ({plans.length})
            </span>
          </TabsTrigger>
          <TabsTrigger value="quotes">
            <FileText size={14} />
            Quotes
            {pendingQuotesCount > 0 && (
              <span className="ml-1 text-xs text-[#2E37FE]">
                ({pendingQuotesCount} pending)
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="subscriptions">
            <Users size={14} />
            Subscriptions
            <span className="ml-1 text-xs text-muted-foreground">
              ({subscriptions.length})
            </span>
          </TabsTrigger>
          <TabsTrigger value="invoices">
            <Receipt size={14} />
            Invoices
            <span className="ml-1 text-xs text-muted-foreground">
              ({invoices.length})
            </span>
          </TabsTrigger>
        </TabsList>

        {/* Plans */}
        <TabsContent value="plans" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Click a plan card to edit. Changes sync to Stripe once wired.
            </p>
            <Button
              size="sm"
              style={{ background: "#2E37FE" }}
              onClick={() => setCreatingPlan(true)}
            >
              <Plus size={14} className="mr-1" />
              New plan
            </Button>
          </div>
          {plans.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 p-8 text-center text-sm text-muted-foreground">
              {loading
                ? "Loading plans…"
                : "No plans yet. Click New plan to create your first one — it'll sync to Stripe as a Product + Price on save."}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {plans.map((plan) => {
              const subCount = subscriptions.filter(
                (s) => s.plan_id === plan.id,
              ).length;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => setEditingPlan(plan)}
                  className="text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2E37FE] rounded-xl"
                >
                  <Card
                    className={`group transition-all hover:border-[#2E37FE]/40 hover:shadow-md cursor-pointer ${!plan.active ? "opacity-60" : ""}`}
                  >
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-lg">{plan.name}</h3>
                          <Pencil
                            size={13}
                            className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
                          />
                        </div>
                        <Badge
                          variant="secondary"
                          className="bg-[#2E37FE]/20 text-[#6B72FF] border border-[#2E37FE]/20"
                        >
                          {subCount} client{subCount !== 1 ? "s" : ""}
                        </Badge>
                      </div>
                      {plan.description && (
                        <p className="text-xs text-muted-foreground">
                          {plan.description}
                        </p>
                      )}
                      <p className="text-3xl font-bold">
                        {formatCents(plan.monthly_price_cents)}
                        <span className="text-sm font-normal text-muted-foreground">
                          /mo
                        </span>
                      </p>
                      <ul className="space-y-1.5">
                        {plan.features.map((f, i) => (
                          <li
                            key={`${plan.id}-${i}`}
                            className="text-sm text-muted-foreground flex items-center gap-2"
                          >
                            <CheckCircle
                              size={13}
                              className="text-emerald-500 shrink-0"
                            />
                            {f}
                          </li>
                        ))}
                      </ul>
                      {!plan.active && (
                        <Badge variant="secondary" className="badge-slate">
                          Archived
                        </Badge>
                      )}
                    </CardContent>
                  </Card>
                </button>
              );
            })}
          </div>
        </TabsContent>

        {/* Quotes */}
        <TabsContent value="quotes" className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Formal proposals sent to clients. Accept &amp; pay triggers a
              Stripe Checkout.
            </p>
            <Button
              size="sm"
              style={{ background: "#2E37FE" }}
              onClick={() => setNewQuoteOpen(true)}
            >
              <FileText size={14} className="mr-1" />
              New quote
            </Button>
          </div>
          <Card className="border-border/50 shadow-sm">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Quote</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead className="hidden sm:table-cell">Plan</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead className="text-right hidden md:table-cell">
                      Setup
                    </TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Sent</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {quotes.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        {loading ? (
                          "Loading…"
                        ) : (
                          <>
                            No quotes yet. Click <strong>New quote</strong> to
                            draft one.
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                  {quotes.map((q) => (
                    <TableRow key={q.id} className="group">
                      <TableCell className="font-mono text-xs">
                        {q.quote_number}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div
                            className="flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold text-white shrink-0"
                            style={{ background: "#2E37FE" }}
                          >
                            {clientName(q.client_id, clients).charAt(0)}
                          </div>
                          <span className="text-sm">
                            {clientName(q.client_id, clients)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-sm">
                        {q.plan_name_snapshot || planName(q.plan_id, plans)}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCents(q.monthly_price_cents)}
                      </TableCell>
                      <TableCell className="text-right hidden md:table-cell text-sm">
                        {q.setup_fee_cents > 0
                          ? formatCents(q.setup_fee_cents)
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <QuoteStatusBadge status={q.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                        {q.sent_at
                          ? new Date(q.sent_at).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled
                          className="text-xs opacity-60"
                        >
                          View
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Subscriptions */}
        <TabsContent value="subscriptions" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Live subscription state mirrored from Stripe.
          </p>
          <Card className="border-border/50 shadow-sm">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="hidden sm:table-cell">Plan</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden md:table-cell">
                      Next bill
                    </TableHead>
                    <TableHead className="hidden lg:table-cell">
                      Warming ends
                    </TableHead>
                    <TableHead className="hidden xl:table-cell font-mono text-xs">
                      Stripe ID
                    </TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={8}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        {loading
                          ? "Loading…"
                          : "No subscriptions yet. They appear here once a client accepts a quote and pays."}
                      </TableCell>
                    </TableRow>
                  )}
                  {subscriptions.map((s) => {
                    const plan = plans.find((p) => p.id === s.plan_id);
                    return (
                      <TableRow key={s.id}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div
                              className="flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold text-white shrink-0"
                              style={{ background: "#2E37FE" }}
                            >
                              {clientName(s.client_id, clients).charAt(0)}
                            </div>
                            <div className="min-w-0">
                              <span className="font-medium block truncate">
                                {clientName(s.client_id, clients)}
                              </span>
                              <span className="text-xs text-muted-foreground sm:hidden">
                                {plan?.name}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm">
                          {plan?.name ?? "—"}
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {plan ? formatCents(plan.monthly_price_cents) : "—"}
                        </TableCell>
                        <TableCell>
                          <SubStatusBadge status={s.status} />
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                          {s.current_period_end
                            ? new Date(s.current_period_end).toLocaleDateString()
                            : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                          {s.status === "trialing" && s.trial_end
                            ? new Date(s.trial_end).toLocaleDateString()
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground font-mono hidden xl:table-cell">
                          {s.stripe_subscription_id || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {s.status === "canceled" ? (
                              <span className="text-xs text-muted-foreground">
                                Canceled
                              </span>
                            ) : (
                              <>
                                {s.cancel_at_period_end && (
                                  <span className="text-xs text-amber-600 hidden md:inline">
                                    Ends{" "}
                                    {s.current_period_end
                                      ? new Date(
                                          s.current_period_end,
                                        ).toLocaleDateString()
                                      : "period end"}
                                  </span>
                                )}
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors outline-none cursor-pointer disabled:opacity-50"
                                    disabled={rowActionLoading === s.id}
                                    aria-label="Subscription actions"
                                  >
                                    <MoreHorizontal size={16} />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-64">
                                    <DropdownMenuItem
                                      disabled={portalSending === s.client_id}
                                      onClick={() =>
                                        handleSendPortal(s.client_id, false)
                                      }
                                    >
                                      <ExternalLink size={14} />
                                      Copy billing portal URL
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      disabled={portalSending === s.client_id}
                                      onClick={() =>
                                        handleSendPortal(s.client_id, true)
                                      }
                                    >
                                      <CreditCard size={14} />
                                      {portalSentFor === s.client_id
                                        ? "Emailed ✓"
                                        : portalSending === s.client_id
                                          ? "Sending…"
                                          : "Email portal link to client"}
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    {s.cancel_at_period_end && (
                                      <DropdownMenuItem
                                        onClick={() => handleUncancelSub(s.id)}
                                      >
                                        <RotateCcw size={14} />
                                        Un-cancel (keep active)
                                      </DropdownMenuItem>
                                    )}
                                    {s.status === "paused" ? (
                                      <DropdownMenuItem
                                        onClick={() =>
                                          handlePauseResume(s.id, "resume")
                                        }
                                      >
                                        <Play size={14} />
                                        Resume billing
                                      </DropdownMenuItem>
                                    ) : (
                                      <DropdownMenuItem
                                        onClick={() =>
                                          handlePauseResume(s.id, "pause")
                                        }
                                      >
                                        <Pause size={14} />
                                        Pause billing
                                      </DropdownMenuItem>
                                    )}
                                    {!s.cancel_at_period_end && (
                                      <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onClick={() => setCancelingSub(s)}
                                        >
                                          <X size={14} />
                                          Cancel at period end
                                        </DropdownMenuItem>
                                      </>
                                    )}
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => setCancelNowSub(s)}
                                    >
                                      <Ban size={14} />
                                      Cancel immediately
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Invoices */}
        <TabsContent value="invoices" className="space-y-4">
          <p className="text-sm text-muted-foreground">
            All invoices from Stripe, including paid, open, and past-due.
          </p>
          <Card className="border-border/50 shadow-sm">
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead className="hidden md:table-cell">Period</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Paid</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoices.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-sm text-muted-foreground py-8"
                      >
                        {loading
                          ? "Loading…"
                          : "No invoices yet. They appear here after the first charge."}
                      </TableCell>
                    </TableRow>
                  )}
                  {invoices.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell className="font-mono text-xs">
                        {inv.stripe_invoice_number || inv.id}
                      </TableCell>
                      <TableCell className="text-sm">
                        {clientName(inv.client_id, clients)}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground hidden md:table-cell">
                        {inv.period_start
                          ? `${new Date(inv.period_start).toLocaleDateString()} – ${inv.period_end ? new Date(inv.period_end).toLocaleDateString() : "—"}`
                          : "—"}
                      </TableCell>
                      <TableCell className="text-right font-medium">
                        {formatCents(inv.amount_cents)}
                      </TableCell>
                      <TableCell>
                        <InvoiceStatusBadge status={inv.status} />
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground hidden lg:table-cell">
                        {inv.paid_at
                          ? new Date(inv.paid_at).toLocaleDateString()
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {inv.hosted_invoice_url ? (
                          <a
                            href={inv.hosted_invoice_url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-[#2E37FE] hover:underline"
                          >
                            <ExternalLink size={12} />
                            View
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Stripe integration footer */}
      <Card className="border-border/50 shadow-sm">
        <CardHeader className="flex flex-row items-center gap-2 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
            <CreditCard size={16} className="text-white" />
          </div>
          <CardTitle className="text-base">Stripe Integration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={
              "rounded-xl border p-5 space-y-2 " +
              (stripeMode === "live"
                ? "border-emerald-200 bg-emerald-50"
                : stripeMode === "test"
                  ? "border-amber-200 bg-amber-50"
                  : "border-dashed border-[#2E37FE]/20 bg-[#2E37FE]/5")
            }
          >
            <div className="flex items-center gap-2">
              <span
                className={
                  "inline-flex h-2 w-2 rounded-full " +
                  (stripeMode === "live"
                    ? "bg-emerald-500"
                    : stripeMode === "test"
                      ? "bg-amber-500"
                      : "bg-slate-400")
                }
              />
              <p className="text-sm font-semibold">
                {stripeMode === "live"
                  ? "Connected — Live mode"
                  : stripeMode === "test"
                    ? "Connected — Test mode"
                    : "Demo mode (no Stripe key configured)"}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {stripeMode === "demo"
                ? "Set STRIPE_SECRET_KEY in Vercel to connect. Plans and data shown here are local mocks."
                : "Webhook events route to /api/webhooks/stripe. Subscriptions and invoices populate automatically as Stripe fires events."}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Quote → Checkout</p>
              <p className="text-muted-foreground text-xs">
                Accept button on a quote opens a Stripe Checkout session that
                charges the setup fee now and delays the first monthly charge
                for the 14-day warming window.
              </p>
            </div>
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Dunning</p>
              <p className="text-muted-foreground text-xs">
                Stripe retries failed payments; we send a branded nudge via
                Resend.
              </p>
            </div>
            <div className="rounded-xl border border-border/50 p-4 space-y-1">
              <p className="font-semibold">Customer Portal</p>
              <p className="text-muted-foreground text-xs">
                Admin emails a one-time link so the client can update card or
                view invoices. Cancel is admin-only.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Dialogs */}
      <PlanEditDialog
        plan={editingPlan}
        open={editingPlan !== null || creatingPlan}
        mode={editingPlan !== null ? "edit" : "create"}
        onOpenChange={(o) => {
          if (!o) {
            setEditingPlan(null);
            setCreatingPlan(false);
          }
        }}
        onSave={savePlan}
        onCreate={createPlan}
      />
      <NewQuoteDialog
        open={newQuoteOpen}
        onOpenChange={setNewQuoteOpen}
        onCreate={createQuote}
        clients={clients}
        plans={plans}
      />
      <Dialog
        open={portalUrlDialog !== null}
        onOpenChange={(o) => !o && setPortalUrlDialog(null)}
      >
        <DialogContent className="w-[95vw] max-w-lg p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Stripe Billing Portal link</DialogTitle>
            <DialogDescription>
              {portalUrlDialog?.reason === "no_email" ? (
                <>
                  <strong>{portalUrlDialog.clientName}</strong> has no{" "}
                  <code>contact_email</code> on file, so the email wasn&apos;t
                  sent. Copy this one-time URL and share it with them directly
                  (it expires after a short time if unused).
                </>
              ) : (
                <>
                  Copy this one-time URL for{" "}
                  <strong>{portalUrlDialog?.clientName}</strong>. Stripe expires
                  the link after a short time if unused.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={portalUrlDialog?.url ?? ""}
                className="font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (portalUrlDialog)
                    navigator.clipboard.writeText(portalUrlDialog.url);
                }}
              >
                Copy
              </Button>
            </div>
            {portalUrlDialog && (
              <a
                href={portalUrlDialog.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[#2E37FE] hover:underline"
              >
                <ExternalLink size={12} />
                Open in new tab
              </a>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setPortalUrlDialog(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={cancelNowSub !== null}
        onOpenChange={(o) => !o && !cancelSubmitting && setCancelNowSub(null)}
      >
        <DialogContent className="w-[95vw] max-w-md p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Cancel immediately?</DialogTitle>
            <DialogDescription>
              {cancelNowSub && (
                <>
                  <strong>{clientName(cancelNowSub.client_id, clients)}</strong>
                  {" "}
                  will be canceled <strong>right now</strong> — no more charges
                  and access ends immediately. There is no pro-ration refund.
                  This cannot be reversed.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setCancelNowSub(null)}
              disabled={cancelSubmitting}
              className="w-full sm:w-auto"
            >
              Keep active
            </Button>
            <Button
              onClick={() =>
                cancelNowSub && handleCancelNow(cancelNowSub.id)
              }
              disabled={cancelSubmitting}
              className="w-full sm:w-auto bg-red-600 hover:bg-red-700 text-white"
            >
              {cancelSubmitting ? "Canceling…" : "Cancel immediately"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={cancelingSub !== null}
        onOpenChange={(o) => !o && !cancelSubmitting && setCancelingSub(null)}
      >
        <DialogContent className="w-[95vw] max-w-md p-4 sm:p-6">
          <DialogHeader>
            <DialogTitle>Cancel subscription?</DialogTitle>
            <DialogDescription>
              {cancelingSub && (
                <>
                  <strong>{clientName(cancelingSub.client_id, clients)}</strong>{" "}
                  will keep access through{" "}
                  <strong>
                    {cancelingSub.current_period_end
                      ? new Date(
                          cancelingSub.current_period_end,
                        ).toLocaleDateString()
                      : "the end of the current period"}
                  </strong>
                  . No further charges, no pro-ration refund. You can un-cancel
                  from the Stripe dashboard before the period ends.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 flex-col sm:flex-row">
            <Button
              variant="outline"
              onClick={() => setCancelingSub(null)}
              disabled={cancelSubmitting}
              className="w-full sm:w-auto"
            >
              Keep active
            </Button>
            <Button
              onClick={() =>
                cancelingSub && handleCancelSub(cancelingSub.id)
              }
              disabled={cancelSubmitting}
              className="w-full sm:w-auto bg-red-600 hover:bg-red-700 text-white"
            >
              {cancelSubmitting ? "Canceling…" : "Cancel at period end"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
