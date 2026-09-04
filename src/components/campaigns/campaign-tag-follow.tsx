"use client";

// Live mailbox-tag binding control for a campaign's Setup tab (migration 00119).
// When a campaign "follows" a tag, its sending pool auto-syncs to the inboxes
// carrying that tag — add an inbox to the tag and it joins the campaign on the
// next reconcile. This component owns the bind/unbind action
// (a dedicated PUT that reconciles server-side) and refreshes the page so the
// pool + banner reflect the new state. While bound, the parent disables the
// manual mailbox picker.

import { useState } from "react";
import Link from "next/link";
import { Tag, Loader2, AlertTriangle, Check } from "lucide-react";
import { appUrl } from "@/lib/api-url";

interface SyncResult {
  tag: string | null;
  synced: boolean;
  added: string[];
  removed: string[];
  skippedInUse: { id: string; email: string; byCampaign: string }[];
  emptyGuard: boolean;
}

export function CampaignTagFollow({
  campaignId,
  boundTag,
  availableTags,
  onChanged,
}: {
  campaignId: string;
  boundTag: string | null;
  availableTags: string[];
  onChanged: () => void;
}) {
  const [choice, setChoice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  async function bind(tag: string | null) {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch(appUrl(`/api/admin/campaigns/${campaignId}/mailbox-tag`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      const data = (await res.json().catch(() => ({}))) as SyncResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't update the tag binding.");

      if (tag === null) {
        setSummary(null);
      } else {
        const bits: string[] = [];
        if (data.added.length) bits.push(`added ${data.added.length}`);
        if (data.removed.length) bits.push(`removed ${data.removed.length}`);
        let msg = `Now following “${data.tag}”${bits.length ? ` — ${bits.join(", ")} inbox${data.added.length + data.removed.length === 1 ? "" : "es"}` : ""}.`;
        if (data.emptyGuard) {
          msg += " No inbox could be added for this tag right now — new inboxes you tag will be added automatically.";
        }
        if (data.skippedInUse.length) {
          msg += ` ${data.skippedInUse.length} tagged inbox${data.skippedInUse.length === 1 ? " is" : "es are"} in use by another campaign and were skipped.`;
        }
        setSummary(msg);
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  // ── Bound: show the live binding + unfollow ────────────────────────────────
  if (boundTag) {
    return (
      <div className="space-y-1.5 rounded-lg border border-[#2E37FE]/25 bg-[#2E37FE]/5 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[#2E37FE]">
            <Tag size={13} /> Following tag “{boundTag}”
          </span>
          <button
            type="button"
            onClick={() => bind(null)}
            disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-secondary-foreground transition-colors hover:border-[#2E37FE]/50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy && <Loader2 size={11} className="animate-spin" />} Unfollow
          </button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Inboxes carrying this tag are added to the rotation automatically. Manage
          the tag on the{" "}
          <Link href="/admin/mailboxes" className="underline hover:text-foreground">
            Mailboxes
          </Link>{" "}
          page. Unfollow to edit the pool by hand.
        </p>
        {summary && <p className="text-[11px] text-[#2E37FE]">{summary}</p>}
        {err && <p className="text-[11px] text-red-600">{err}</p>}
      </div>
    );
  }

  // ── Unbound: offer to follow a tag ─────────────────────────────────────────
  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/20 p-3">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary-foreground">
        <Tag size={13} /> Follow a tag <span className="text-muted-foreground">(auto-add inboxes)</span>
      </span>
      {availableTags.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          No inbox tags yet. Tag inboxes on the{" "}
          <Link href="/admin/mailboxes" className="underline hover:text-foreground">
            Mailboxes
          </Link>{" "}
          page, then a campaign can follow that tag and auto-add new inboxes.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <select
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              disabled={busy}
              className="min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs outline-none focus:border-[#2E37FE]/50 disabled:opacity-60"
            >
              <option value="">Choose a tag…</option>
              {availableTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => choice && bind(choice)}
              disabled={busy || !choice}
              className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#2E37FE] px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#2731d6] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Follow
            </button>
          </div>
          <p className="inline-flex items-start gap-1 text-[11px] text-muted-foreground">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            Following a tag replaces the manual selection above and keeps the pool
            in sync with the tag from then on.
          </p>
        </>
      )}
      {err && <p className="text-[11px] text-red-600">{err}</p>}
    </div>
  );
}
