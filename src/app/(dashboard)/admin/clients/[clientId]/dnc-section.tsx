"use client";

// Per-client do-not-contact list on the client detail page. Shows the
// client's suppressed emails (auto-added on opt-out replies, plus manual
// adds), with add/remove. Scoped to this client only — an entry here never
// affects another client's campaigns.

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronRight, ShieldBan, Plus, Trash2, Loader2 } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface DncEntry {
  id: string;
  email: string;
  reason: string;
  source_channel: string | null;
  notes: string | null;
  created_at: string;
}

const REASON_LABEL: Record<string, string> = {
  unsubscribe: "Opted out",
  manual: "Added manually",
  complaint: "Complaint",
  bounce: "Bounced",
};

export function DncSection({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DncEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(appUrl(`/api/admin/clients/${clientId}/dnc`));
      const data = (await res.json()) as { entries?: DncEntry[] };
      setEntries(data.entries ?? []);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && entries === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function add() {
    const e = email.trim().toLowerCase();
    if (!e || !e.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(appUrl(`/api/admin/clients/${clientId}/dnc`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: e }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? "Could not add.");
        return;
      }
      setEmail("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await fetch(appUrl(`/api/admin/clients/${clientId}/dnc?id=${id}`), { method: "DELETE" });
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader
        className="flex flex-row items-center gap-2 pb-3 cursor-pointer select-none"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#EA4335]">
          <ShieldBan size={16} className="text-white" />
        </div>
        <div className="flex-1">
          <CardTitle className="text-base">
            Do-not-contact list{entries ? ` (${entries.length})` : ""}
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Suppressed for {clientName}&apos;s campaigns only — never other clients.
          </p>
        </div>
        {open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
      </CardHeader>

      {open && (
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <Input
              type="email"
              placeholder="add-email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              className="h-9"
            />
            <Button size="sm" onClick={add} disabled={busy} className="gap-1 shrink-0">
              <Plus size={14} /> Add
            </Button>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
          <p className="text-[11px] text-muted-foreground">
            Opt-out replies (&quot;stop&quot;, &quot;unsubscribe&quot;, &quot;no more&quot;) are added here automatically.
          </p>

          {loading ? (
            <p className="text-xs text-muted-foreground inline-flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </p>
          ) : entries && entries.length > 0 ? (
            <div className="rounded-md border border-border/60 divide-y divide-border/40">
              {entries.map((e) => (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-[#0f172a]">{e.email}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {REASON_LABEL[e.reason] ?? e.reason}
                      {e.source_channel ? ` · ${e.source_channel}` : ""} ·{" "}
                      {new Date(e.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(e.id)}
                    disabled={busy}
                    aria-label="Remove"
                    className="text-red-600 hover:text-red-700 shrink-0 cursor-pointer"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No suppressed contacts yet.</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}
