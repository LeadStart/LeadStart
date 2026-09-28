"use client";

// An inbox's sending identity (owner, 2026-09-27): the name it sends as, the
// signature it signs with, and its warmup. The name fills {{your_name}} and the
// From header; the signature fills {{signature}} in every email this inbox sends
// (native_mailboxes.signature, migration 00133; see resolveSignature in
// src/lib/native/tokens.ts). Warmup: the cadence itself is fixed (src/lib/gmail/
// ramp.ts: start at RAMP_STAGES[0].cap/day, +1 a day as the inbox sends); what
// each inbox sets is the cap it ramps up to (max_daily_cap, never above
// ABSOLUTE_MAX_DAILY_CAP). A daily_cap_override bypasses the ramp, so it is only
// shown and cleared here, never set.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { appUrl } from "@/lib/api-url";
import { ABSOLUTE_MAX_DAILY_CAP, RAMP_STAGES } from "@/lib/gmail/ramp";
import { resolveSignature } from "@/lib/native/tokens";

type IdentityMailbox = {
  id: string;
  email_address: string;
  display_name: string | null;
  signature?: string | null;
  ramp_started_at: string;
  effective_daily_cap: number;
  warmed: boolean;
  max_daily_cap: number;
  daily_cap_override: number | null;
};

const RAMP_START = RAMP_STAGES[0].cap;

export function MailboxIdentity({ mailbox, onSaved }: { mailbox: IdentityMailbox; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(mailbox.display_name ?? "");
  const [signature, setSignature] = useState(mailbox.signature ?? "");
  const [cap, setCap] = useState(String(mailbox.max_daily_cap));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  useEffect(() => {
    setName(mailbox.display_name ?? "");
    setSignature(mailbox.signature ?? "");
    setCap(String(mailbox.max_daily_cap));
  }, [mailbox.id, mailbox.display_name, mailbox.signature, mailbox.max_daily_cap]);

  const capNum = Number(cap);
  const capValid = Number.isInteger(capNum) && capNum >= 1 && capNum <= ABSOLUTE_MAX_DAILY_CAP;
  const capDirty = capValid && capNum !== mailbox.max_daily_cap;
  const dirty =
    name.trim() !== (mailbox.display_name ?? "") ||
    signature.trim() !== (mailbox.signature ?? "").trim() ||
    capDirty;
  // What {{signature}} will print for this inbox, exactly as the sender resolves it.
  const senderName = name.trim() || mailbox.email_address.split("@")[0];
  const signsAs = resolveSignature(signature, senderName);

  async function patch(body: Record<string, unknown>) {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(appUrl(`/api/admin/mailboxes/${mailbox.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  const save = () =>
    patch({ display_name: name, signature, ...(capDirty ? { max_daily_cap: capNum } : {}) });

  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-white p-3">
      <p className="text-xs font-semibold text-[#0f172a] uppercase tracking-wide">Identity and warmup</p>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`identity-name-${mailbox.id}`} className="text-xs">Name (the From name, and {"{{your_name}}"})</Label>
            <Input
              id={`identity-name-${mailbox.id}`}
              value={name}
              placeholder={mailbox.email_address.split("@")[0]}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`identity-cap-${mailbox.id}`} className="text-xs">Warmup: ramps up to (sends a day)</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`identity-cap-${mailbox.id}`}
                type="number"
                min={1}
                max={ABSOLUTE_MAX_DAILY_CAP}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                className="w-24"
              />
              <span className="text-[11px] text-muted-foreground">
                {mailbox.warmed
                  ? `Warmed: sending up to ${mailbox.effective_daily_cap}/day.`
                  : `Ramping: ${mailbox.effective_daily_cap}/day today (started ${mailbox.ramp_started_at}).`}
              </span>
            </div>
            {!capValid && (
              <p className="text-[11px] text-red-600">Enter a whole number from 1 to {ABSOLUTE_MAX_DAILY_CAP}.</p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {`Every new inbox starts at ${RAMP_START}/day and adds 1 a day as it actually sends, until it reaches this cap. An idle or paused inbox holds its place instead of skipping ahead. ${ABSOLUTE_MAX_DAILY_CAP}/day is the hard ceiling.`}
            </p>
            {mailbox.daily_cap_override != null && (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                <span>
                  Fixed at {mailbox.daily_cap_override}/day: this inbox skips the warmup ramp.
                </span>
                <button
                  type="button"
                  onClick={() => patch({ daily_cap_override: null })}
                  disabled={saving}
                  className="font-semibold underline underline-offset-2"
                >
                  Use the ramp again
                </button>
              </div>
            )}
          </div>
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
        <Button size="sm" onClick={save} disabled={saving || !dirty || !capValid} style={{ background: "#2E37FE" }}>
          {saving ? "Saving…" : "Save"}
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
