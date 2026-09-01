"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pencil, Plus, X } from "lucide-react";
import { appUrl } from "@/lib/api-url";

/**
 * Inline add/edit for a client's on-file email (clients.contact_email).
 *
 * Saves via PATCH /api/clients/[id] (owner/va, service-role write) so it persists
 * for VAs too — not just owners — and never silently no-ops. Safe to drop inside a
 * clickable table row: it only renders <input>/<button> (excluded from row-click
 * navigation) and carries data-row-click-ignore as belt-and-suspenders.
 */
export function ClientEmailInline({
  clientId,
  email,
  onSaved,
  className,
}: {
  clientId: string;
  email: string | null;
  onSaved: (email: string) => void;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/clients/${clientId}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_email: trimmed }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || "Could not save email");
      }
      onSaved(trimmed);
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setEditing(false);
    setValue(email ?? "");
    setError(null);
  }

  if (editing) {
    return (
      <span
        data-row-click-ignore
        className={`inline-flex items-center gap-1.5 ${className ?? ""}`}
      >
        <Input
          type="email"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="client@company.com"
          className="h-7 w-56 text-xs"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") cancel();
          }}
        />
        <Button
          type="button"
          size="sm"
          onClick={save}
          disabled={saving || !value.trim()}
          className="h-7 text-xs"
          style={{ background: "#2E37FE" }}
        >
          {saving ? "…" : "Save"}
        </Button>
        <button
          type="button"
          onClick={cancel}
          aria-label="Cancel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X size={14} />
        </button>
        {error && <span className="text-xs text-red-600">{error}</span>}
      </span>
    );
  }

  if (email) {
    return (
      <span
        data-row-click-ignore
        className={`inline-flex items-center gap-1.5 text-xs ${className ?? ""}`}
      >
        <span className="text-foreground">{email}</span>
        <button
          type="button"
          onClick={() => {
            setValue(email);
            setEditing(true);
          }}
          aria-label="Edit email"
          className="text-muted-foreground hover:text-foreground"
        >
          <Pencil size={11} />
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      data-row-click-ignore
      onClick={() => {
        setValue("");
        setEditing(true);
      }}
      className={`inline-flex items-center gap-1 text-xs text-amber-600 hover:text-amber-700 ${className ?? ""}`}
    >
      <Plus size={12} />
      Add email on file
    </button>
  );
}
