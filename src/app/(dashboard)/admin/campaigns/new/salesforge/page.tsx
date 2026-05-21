"use client";

// /admin/campaigns/new/salesforge — sequence builder for Salesforge
// (email) campaigns. The composite endpoint at
// /api/admin/salesforge/sequences/create handles the full Salesforge-
// side flow (create shell → set steps → assign mailboxes → optionally
// launch → register webhooks → insert local campaigns row).
//
// Saved draft: stays in Salesforge with status='draft'; not sending.
// Saved + launch: status='active'; Salesforge starts sending immediately.
//
// Mailbox connection (the OAuth dance with Gmail / Outlook) is the one
// thing Salesforge doesn't expose via API — the user has to connect a
// sender in app.salesforge.ai → Senders & Mailboxes before mailboxes
// show up in this page's dropdown.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  Save,
  Send,
  Loader2,
  AlertCircle,
} from "lucide-react";
import Link from "next/link";
import { appUrl } from "@/lib/api-url";
import { useUser } from "@/hooks/use-user";

interface StepDraft {
  subject: string;
  body: string;
  wait_days: number;
}

interface Client {
  id: string;
  name: string;
}

interface SalesforgeProduct {
  id: string;
  name: string;
}

interface SalesforgeMailbox {
  id: string;
  email: string;
  status?: string;
}

const LANGUAGE_OPTIONS = [
  { value: "american_english", label: "English (US)" },
  { value: "british_english", label: "English (UK)" },
  { value: "french", label: "French" },
  { value: "spanish", label: "Spanish" },
  { value: "german", label: "German" },
  { value: "italian", label: "Italian" },
  { value: "dutch", label: "Dutch" },
  { value: "portuguese", label: "Portuguese (BR)" },
];

const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Toronto",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const DEFAULT_STEPS: StepDraft[] = [
  {
    subject: "Quick question, {{first_name}}",
    body:
      "Hi {{first_name}},\n\nNoticed {{company}} is doing X — curious whether [pain point] comes up much for your team?\n\nWorth a 15-minute chat to share what's worked for similar companies?\n\nBest,\n{{sender_first_name}}",
    wait_days: 0,
  },
  {
    subject: "Re: Quick question",
    body:
      "Just bumping this up, {{first_name}} — happy to send a 1-pager if a call doesn't fit right now.",
    wait_days: 3,
  },
  {
    subject: "Closing the loop",
    body:
      "I'll stop bugging you here, {{first_name}}. If timing's off, no worries — feel free to reach out anytime.",
    wait_days: 5,
  },
];

export default function NewSalesforgeCampaignPage() {
  const router = useRouter();
  const { organizationId } = useUser();

  const [clients, setClients] = useState<Client[]>([]);
  const [products, setProducts] = useState<SalesforgeProduct[]>([]);
  const [mailboxes, setMailboxes] = useState<SalesforgeMailbox[]>([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string>("");
  const [productId, setProductId] = useState<string>("");
  const [language, setLanguage] = useState("american_english");
  const [timezone, setTimezone] = useState("America/New_York");
  const [selectedMailboxIds, setSelectedMailboxIds] = useState<string[]>([]);
  const [steps, setSteps] = useState<StepDraft[]>(DEFAULT_STEPS);
  // Daily contact cap — gates how many NEW contacts the
  // dispatch-salesforge-enrollments cron will push into this sequence
  // per UTC day (the cron runs once daily at 15:00 UTC ≈ 8am Pacific).
  // Default 66 = (8 inboxes × 25 sends/day) / 3-step sequence at
  // steady state. Tune up for shorter sequences, down for safer ramps.
  const [dailyCap, setDailyCap] = useState<number>(66);

  const [saving, setSaving] = useState(false);
  const [savingMode, setSavingMode] = useState<"draft" | "launch" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!organizationId) return;
    const supabase = createClient();
    let active = true;

    (async () => {
      setLoadingMeta(true);
      setMetaError(null);
      try {
        const [clientsResp, productsResp, mailboxesResp] = await Promise.all([
          supabase
            .from("clients")
            .select("id, name")
            .eq("organization_id", organizationId)
            .order("name"),
          fetch(appUrl("/api/admin/salesforge/products")).then((r) => r.json()),
          fetch(appUrl("/api/admin/salesforge/mailboxes")).then((r) => r.json()),
        ]);
        if (!active) return;
        if (clientsResp.data) setClients(clientsResp.data as Client[]);
        if (Array.isArray(productsResp.products)) {
          setProducts(productsResp.products);
          // If only one product, auto-select.
          if (productsResp.products.length === 1) {
            setProductId(productsResp.products[0].id);
          }
        } else if (productsResp.error) {
          setMetaError(`Products: ${productsResp.error}`);
        }
        if (Array.isArray(mailboxesResp.mailboxes)) {
          setMailboxes(mailboxesResp.mailboxes);
        } else if (mailboxesResp.error) {
          setMetaError((prev) =>
            prev
              ? `${prev}; Mailboxes: ${mailboxesResp.error}`
              : `Mailboxes: ${mailboxesResp.error}`,
          );
        }
      } catch (err) {
        if (!active) return;
        setMetaError(err instanceof Error ? err.message : String(err));
      } finally {
        if (active) setLoadingMeta(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [organizationId]);

  function updateStep(index: number, patch: Partial<StepDraft>) {
    setSteps((prev) =>
      prev.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
  }

  function moveStep(index: number, dir: -1 | 1) {
    setSteps((prev) => {
      const target = index + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function addStep() {
    setSteps((prev) => [
      ...prev,
      { subject: "", body: "", wait_days: 3 },
    ]);
  }

  function removeStep(index: number) {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  }

  function toggleMailbox(id: string) {
    setSelectedMailboxIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleSave(launch: boolean) {
    setError(null);
    if (!name.trim()) {
      setError("Sequence name is required.");
      return;
    }
    if (!productId) {
      setError("Pick a product before saving.");
      return;
    }
    if (launch && selectedMailboxIds.length === 0) {
      setError(
        "At least one mailbox must be selected before launching. (Drafts can save without one.)",
      );
      return;
    }
    if (steps.some((s) => !s.body.trim())) {
      setError("Every step needs body content.");
      return;
    }

    setSaving(true);
    setSavingMode(launch ? "launch" : "draft");
    try {
      const res = await fetch(
        appUrl("/api/admin/salesforge/sequences/create"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            product_id: productId,
            language,
            timezone,
            client_id: clientId || null,
            mailbox_ids: selectedMailboxIds,
            launch,
            register_webhooks: true,
            daily_contact_cap: dailyCap,
            steps: steps.map((s) => ({
              subject: s.subject,
              body: s.body,
              wait_days: s.wait_days,
            })),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      // Navigate to the new campaign — falling back to /admin/campaigns
      // if for some reason we don't have a campaign_id (orphan flow).
      if (data.campaign_id) {
        router.push(`/admin/campaigns/${data.campaign_id}`);
      } else {
        router.push("/admin/campaigns");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
      setSavingMode(null);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-2">
        <Link href={appUrl("/admin/campaigns")}>
          <Button variant="ghost" size="sm">
            <ArrowLeft size={14} className="mr-1" /> Back to campaigns
          </Button>
        </Link>
      </div>

      <div
        className="relative overflow-hidden rounded-[20px] p-5 sm:p-7 text-[#0f172a]"
        style={{
          background:
            "linear-gradient(135deg, #EDEEFF 0%, #D1D3FF 50%, #fff 100%)",
          border: "1px solid rgba(46,55,254,0.2)",
        }}
      >
        <p className="text-xs font-medium text-[#64748b]">Salesforge</p>
        <h1 className="text-[20px] sm:text-[22px] font-bold mt-1">
          New email sequence
        </h1>
        <p className="text-sm text-[#0f172a]/60 mt-1">
          Builds a Salesforge sequence and registers the reply-pipeline
          webhooks in one go. Mailboxes must already be connected in
          app.salesforge.ai (the OAuth flow isn't exposed via API).
        </p>
      </div>

      {metaError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-red-700">
              Couldn&apos;t load Salesforge metadata
            </p>
            <p className="text-xs text-red-700/80">{metaError}</p>
          </div>
        </div>
      )}

      {/* Basics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="name">Sequence name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Q2 Cold Outreach — Construction"
              disabled={saving}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label>Link to LeadStart client (optional)</Label>
              <Select value={clientId} onValueChange={(v) => v && setClientId(v)}>
                <SelectTrigger disabled={saving || loadingMeta}>
                  <SelectValue placeholder="None — orphan campaign" />
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

            <div className="space-y-1">
              <Label>Product</Label>
              <Select value={productId} onValueChange={(v) => v && setProductId(v)}>
                <SelectTrigger disabled={saving || loadingMeta}>
                  <SelectValue
                    placeholder={
                      loadingMeta
                        ? "Loading..."
                        : products.length === 0
                          ? "No products in workspace — create one in Salesforge first"
                          : "Pick a product"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Language</Label>
              <Select value={language} onValueChange={(v) => v && setLanguage(v)}>
                <SelectTrigger disabled={saving}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Timezone</Label>
              <Select value={timezone} onValueChange={(v) => v && setTimezone(v)}>
                <SelectTrigger disabled={saving}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Mailboxes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending mailboxes</CardTitle>
          <p className="text-xs text-muted-foreground">
            Pick which connected mailboxes Salesforge should rotate through.
          </p>
        </CardHeader>
        <CardContent>
          {loadingMeta ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : mailboxes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border/60 p-4 text-center">
              <p className="text-sm text-muted-foreground">
                No mailboxes connected to your Salesforge workspace yet.
              </p>
              <a
                href="https://app.salesforge.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[#EA580C] underline mt-1 inline-block"
              >
                Connect one in Salesforge ↗
              </a>
            </div>
          ) : (
            <div className="space-y-2">
              {mailboxes.map((m) => (
                <label
                  key={m.id}
                  className="flex items-center gap-3 rounded-lg border border-border/60 p-3 cursor-pointer hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={selectedMailboxIds.includes(m.id)}
                    onChange={() => toggleMailbox(m.id)}
                    disabled={saving}
                  />
                  <span className="text-sm font-medium flex-1">{m.email}</span>
                  {m.status && (
                    <Badge
                      variant="secondary"
                      className={
                        m.status === "active"
                          ? "badge-green"
                          : "bg-gray-100 text-gray-500"
                      }
                    >
                      {m.status}
                    </Badge>
                  )}
                </label>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pacing — daily new-contact cap */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pacing</CardTitle>
          <p className="text-xs text-muted-foreground">
            Salesforge has no native limit on how many new contacts can be
            enrolled per day. LeadStart enforces one app-side so a big
            upload doesn&apos;t overflow your inbox capacity. The
            enrollment cron runs once daily at ~8am Pacific.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[200px_1fr]">
            <div className="space-y-1">
              <Label htmlFor="daily-cap">New contacts per day</Label>
              <Input
                id="daily-cap"
                type="number"
                min={1}
                value={dailyCap}
                onChange={(e) =>
                  setDailyCap(Math.max(1, parseInt(e.target.value) || 1))
                }
                disabled={saving}
              />
            </div>
            <div className="text-xs text-muted-foreground self-end pb-1">
              Suggested: <strong>200 sends/day ÷ steps in your sequence</strong>.
              For a 3-step sequence on 8 inboxes × 25/day, that&apos;s ~66.
              Tune up if your sequence is shorter, down for a safer ramp.
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Steps */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sequence steps</CardTitle>
          <p className="text-xs text-muted-foreground">
            Each step is one email. Use {`{{first_name}}, {{company}}`} etc.
            for Salesforge variables.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {steps.map((step, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-border/60 p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Step {idx + 1}</h3>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => moveStep(idx, -1)}
                    disabled={idx === 0 || saving}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => moveStep(idx, 1)}
                    disabled={idx === steps.length - 1 || saving}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => removeStep(idx)}
                    disabled={steps.length === 1 || saving}
                  >
                    <Trash2 size={14} className="text-red-600" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_120px]">
                <div className="space-y-1">
                  <Label htmlFor={`subject-${idx}`}>Subject</Label>
                  <Input
                    id={`subject-${idx}`}
                    value={step.subject}
                    onChange={(e) => updateStep(idx, { subject: e.target.value })}
                    placeholder="Email subject"
                    disabled={saving}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`wait-${idx}`}>Wait days</Label>
                  <Input
                    id={`wait-${idx}`}
                    type="number"
                    min={0}
                    value={step.wait_days}
                    onChange={(e) =>
                      updateStep(idx, {
                        wait_days: Math.max(0, parseInt(e.target.value) || 0),
                      })
                    }
                    disabled={saving || idx === 0}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor={`body-${idx}`}>Body</Label>
                <Textarea
                  id={`body-${idx}`}
                  value={step.body}
                  onChange={(e) => updateStep(idx, { body: e.target.value })}
                  rows={6}
                  placeholder="Email body"
                  disabled={saving}
                />
              </div>
            </div>
          ))}

          <Button
            type="button"
            variant="outline"
            onClick={addStep}
            disabled={saving}
          >
            <Plus size={14} className="mr-1" /> Add step
          </Button>
        </CardContent>
      </Card>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <AlertCircle size={16} className="text-red-500 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 sticky bottom-4 z-10 bg-background/80 backdrop-blur p-3 rounded-xl border border-border/60">
        <Button
          variant="outline"
          onClick={() => handleSave(false)}
          disabled={saving}
        >
          {saving && savingMode === "draft" ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : (
            <Save size={14} className="mr-1" />
          )}
          Save as draft
        </Button>
        <Button
          onClick={() => handleSave(true)}
          disabled={saving}
          style={{ background: "#2E37FE" }}
        >
          {saving && savingMode === "launch" ? (
            <Loader2 size={14} className="mr-1 animate-spin" />
          ) : (
            <Send size={14} className="mr-1" />
          )}
          Save and launch
        </Button>
      </div>
    </div>
  );
}
