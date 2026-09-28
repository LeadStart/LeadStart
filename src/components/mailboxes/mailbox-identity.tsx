"use client";

// An inbox's sending identity (owner, 2026-09-27): the name it sends as, the
// signature it signs with, and its warmup cadence. The name fills {{your_name}}
// and the From header; the signature fills {{signature}} in every email this inbox
// sends (native_mailboxes.signature, migration 00133; see resolveSignature in
// src/lib/native/tokens.ts). The ramp is shown read-only: it is set per inbox by
// the warmup schedule (src/lib/gmail/ramp.ts).

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { appUrl } from "@/lib/api-url";
import { resolveSignature } from "@/lib/native/tokens";

type IdentityMailbox = {
  id: string;
  email_address: string;
  display_name: string | null;
  signature?: string | null;
  ramp_started_at: string;
  effective_daily_cap: number;
  warmed: boolean;
};

export function MailboxIdentity({ mailbox, onSaved }: { mailbox: IdentityMailbox; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(mailbox.display_name ?? "");
  const [signature, setSignature] = useState(mailbox.signature ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    setName(mailbox.display_name ?? "");
    setSignature(mailbox.signature ?? "");
  }, [mailbox.id, mailbox.display_name, mailbox.signature]);

  const dirty = name.trim() !== (mailbox.display_name ?? "") || signature.trim() !== (mailbox.signature ?? "").trim();
  // What {{signature}} will print for this inbox, exactly as the sender resolves it.
  const senderName = name.trim() || mailbox.email_address.split("@")[0];
  const signsAs = resolveSignature(signature, senderName);

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mailbox.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ display_name: name, signature }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Save failed (${res.status})`);
      setMessage({ kind: "ok", text: "Saved" });
      await onSaved();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-white p-3">
      <p className="text-xs font-semibold text-[#0f172a] uppercase tracking-wide">Identity</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`identity-name-${mailbox.id}`} className="text-xs">Name (the From name, and {"{{your_name}}"})</Label>
          <Input
            id={`identity-name-${mailbox.id}`}
            value={name}
            placeholder={mailbox.email_address.split("@")[0]}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            {"Warmup: "}
            {mailbox.warmed
              ? `warmed · up to ${mailbox.effective_daily_cap}/day`
              : `ramping · ${mailbox.effective_daily_cap}/day today · ramp started ${mailbox.ramp_started_at}`}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`identity-signature-${mailbox.id}`} className="text-xs">Signature ({"{{signature}}"})</Label>
          <Textarea
            id={`identity-signature-${mailbox.id}`}
            rows={4}
            value={signature}
            placeholder={`{{your_name}}\nTuBe SEO\ngotubeseo.com`}
            onChange={(e) => setSignature(e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">
            {"Fills {{signature}} in every email this inbox sends. {{your_name}} inside it is this inbox's name. Left blank, it signs with the name alone."}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={saving || !dirty} style={{ background: "#2E37FE" }}>
          {saving ? "Saving…" : "Save identity"}
        </Button>
        {message && (
          <span className={`text-xs ${message.kind === "ok" ? "text-emerald-700" : "text-red-600"}`}>{message.text}</span>
        )}
        <span className="text-[11px] text-muted-foreground whitespace-pre-line">
          {"Signs as: "}
          <span className="text-[#0f172a]">{signsAs}</span>
        </span>
      </div>
    </div>
  );
}
