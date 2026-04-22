"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Radio, Save, CheckCircle2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";
import { CLASS_META } from "@/lib/replies/ui";
import type { Client, ReplyClass } from "@/types/app";

const ALL_CLASSES: ReplyClass[] = [
  "true_interest",
  "meeting_booked",
  "qualifying_question",
  "referral_forward",
  "objection_price",
  "objection_timing",
  "wrong_person_no_referral",
  "ooo",
  "not_interested",
  "unsubscribe",
  "needs_review",
];

type FormState = {
  notification_email: string;
  notification_cc_emails: string[];
  phone_number: string;
  persona_name: string;
  persona_title: string;
  persona_linkedin_url: string;
  persona_photo_url: string;
  brand_voice: string;
  signature_block: string;
  auto_notify_classes: ReplyClass[];
};

function clientToForm(client: Client): FormState {
  return {
    notification_email: client.notification_email ?? "",
    notification_cc_emails: client.notification_cc_emails ?? [],
    phone_number: client.phone_number ?? "",
    persona_name: client.persona_name ?? "",
    persona_title: client.persona_title ?? "",
    persona_linkedin_url: client.persona_linkedin_url ?? "",
    persona_photo_url: client.persona_photo_url ?? "",
    brand_voice: client.brand_voice ?? "",
    signature_block: client.signature_block ?? "",
    auto_notify_classes: client.auto_notify_classes ?? [],
  };
}

export function ReplyRoutingSection({
  client,
  onSaved,
}: {
  client: Client;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<FormState>(clientToForm(client));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSavedAt(null);
    setError(null);
  }

  function toggleClass(cls: ReplyClass) {
    setForm((prev) => ({
      ...prev,
      auto_notify_classes: prev.auto_notify_classes.includes(cls)
        ? prev.auto_notify_classes.filter((c) => c !== cls)
        : [...prev.auto_notify_classes, cls],
    }));
    setSavedAt(null);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/clients/${client.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || `Save failed (${res.status})`);
      }
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const populatedCount = [
    form.notification_email,
    form.phone_number,
    form.persona_name,
    form.persona_title,
    form.persona_linkedin_url,
    form.persona_photo_url,
    form.brand_voice,
    form.signature_block,
  ].filter((v) => v.trim().length > 0).length;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader
        className="flex flex-row items-center gap-2 pb-3 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2E37FE]">
          <Radio size={16} className="text-white" />
        </div>
        <CardTitle className="text-base flex-1">Reply routing</CardTitle>
        <span className="text-xs text-muted-foreground">
          {populatedCount}/8 fields &middot; {form.auto_notify_classes.length} hot classes
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </CardHeader>
      {open && (
        <CardContent className="space-y-6">
          <p className="text-xs text-muted-foreground">
            These fields drive the AI reply-routing pipeline — persona used for hot-lead
            dossiers, where hot-lead notifications land, and which classifier outputs
            trigger a notification. Owner-only.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="notification_email">Notification email</Label>
              <Input
                id="notification_email"
                type="email"
                placeholder="alerts@client.com"
                value={form.notification_email}
                onChange={(e) => update("notification_email", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Where hot-lead dossier emails are delivered.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="phone_number">Phone number</Label>
              <Input
                id="phone_number"
                type="tel"
                placeholder="+1 555 123 4567"
                value={form.phone_number}
                onChange={(e) => update("phone_number", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                Shown in the dossier for the client to dial.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Teammate CC emails</Label>
            {form.notification_cc_emails.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                None — client has not added any teammate CCs yet.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {form.notification_cc_emails.map((email) => (
                  <span
                    key={email}
                    className="inline-flex items-center rounded-full bg-[#2E37FE]/10 px-2.5 py-0.5 text-xs text-[#2E37FE]"
                  >
                    {email}
                  </span>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground">
              Managed by the client from their portal. CC&apos;d on hot-lead notifications + portal replies.
            </p>
          </div>

          <div className="space-y-3">
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Persona (Path 1 — real person on alias domain)
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="persona_name">Persona name</Label>
                <Input
                  id="persona_name"
                  placeholder="Sarah Chen"
                  value={form.persona_name}
                  onChange={(e) => update("persona_name", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona_title">Persona title</Label>
                <Input
                  id="persona_title"
                  placeholder="Head of Partnerships"
                  value={form.persona_title}
                  onChange={(e) => update("persona_title", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona_linkedin_url">LinkedIn URL</Label>
                <Input
                  id="persona_linkedin_url"
                  type="url"
                  placeholder="https://linkedin.com/in/..."
                  value={form.persona_linkedin_url}
                  onChange={(e) => update("persona_linkedin_url", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="persona_photo_url">Photo URL</Label>
                <Input
                  id="persona_photo_url"
                  type="url"
                  placeholder="https://..."
                  value={form.persona_photo_url}
                  onChange={(e) => update("persona_photo_url", e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="brand_voice">Brand voice</Label>
            <Textarea
              id="brand_voice"
              rows={3}
              placeholder="Friendly but direct. No emoji. Avoid marketing jargon."
              value={form.brand_voice}
              onChange={(e) => update("brand_voice", e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="signature_block">Email signature</Label>
            <Textarea
              id="signature_block"
              rows={4}
              placeholder={`Sarah Chen\nHead of Partnerships, Acme\nacme.com`}
              value={form.signature_block}
              onChange={(e) => update("signature_block", e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Auto-notify classes</Label>
            <p className="text-[11px] text-muted-foreground">
              Classifier outputs that trigger a hot-lead email. Defaults to the four
              hot classes; unchecking suppresses notifications silently.
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
              {ALL_CLASSES.map((cls) => {
                const checked = form.auto_notify_classes.includes(cls);
                const meta = CLASS_META[cls];
                return (
                  <label
                    key={cls}
                    className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm cursor-pointer transition-colors ${
                      checked
                        ? "border-[#2E37FE]/30 bg-[#2E37FE]/5"
                        : "border-border/50 hover:bg-muted/30"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleClass(cls)}
                      className="h-4 w-4 accent-[#2E37FE]"
                    />
                    <span>{meta.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2 border-t border-border/30">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="gap-1.5"
              style={{ background: '#2E37FE' }}
            >
              <Save size={14} />
              {saving ? "Saving…" : "Save settings"}
            </Button>
            {savedAt && (
              <span className="flex items-center gap-1 text-xs text-emerald-700">
                <CheckCircle2 size={12} /> Saved
              </span>
            )}
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
