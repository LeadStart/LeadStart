"use client";

// Shared sending-mailbox picker for a campaign — used by the new-campaign builder
// and the campaign Setup tab, so both group + select inboxes identically. Beyond a
// flat checkbox list it offers "add a whole category at once": tag quick-add chips
// (Instantly-style named pools) and per-domain select-all subheaders. Presentational
// and controlled — the parent owns `selected` and decides persistence (the builder
// saves on draft-save; Setup auto-saves each change).

import Link from "next/link";
import { Check, Loader2 } from "lucide-react";

export interface PickerMailbox {
  id: string;
  email_address: string;
  status: string;
  tags: string[];
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email.toLowerCase();
}

export function MailboxPoolPicker({
  mailboxes,
  selected,
  onChange,
  disabled = false,
  saving = false,
}: {
  mailboxes: PickerMailbox[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
  saving?: boolean;
}) {
  // Offer active inboxes, plus any already-selected inbox that isn't active (so a
  // paused/errored-but-attached one stays visible and removable).
  const selectable = mailboxes.filter((m) => m.status === "active" || selected.has(m.id));

  if (selectable.length === 0) {
    return (
      <p className="text-xs text-amber-700">
        No active mailboxes.{" "}
        <Link href="/admin/mailboxes" className="underline">
          Add one under Sending → Mailboxes
        </Link>{" "}
        first.
      </p>
    );
  }

  // Tag groups (case-insensitive identity; first-seen casing wins) and domain
  // groups, each carrying the ids of the selectable inboxes in that group.
  const tagGroups = new Map<string, { label: string; ids: string[] }>();
  for (const mb of selectable) {
    for (const tag of mb.tags ?? []) {
      const key = tag.toLowerCase();
      const g = tagGroups.get(key);
      if (g) g.ids.push(mb.id);
      else tagGroups.set(key, { label: tag, ids: [mb.id] });
    }
  }
  const domainGroups = new Map<string, string[]>();
  for (const mb of selectable) {
    const d = domainOf(mb.email_address);
    const ids = domainGroups.get(d);
    if (ids) ids.push(mb.id);
    else domainGroups.set(d, [mb.id]);
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  }

  function toggleGroup(ids: string[]) {
    const allSelected = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    onChange(next);
  }

  const groupState = (ids: string[]): "all" | "some" | "none" => {
    const n = ids.filter((id) => selected.has(id)).length;
    return n === 0 ? "none" : n === ids.length ? "all" : "some";
  };

  const sortedTags = [...tagGroups.values()].sort((a, b) => a.label.localeCompare(b.label));
  const sortedDomains = [...domainGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const selectedCount = selectable.filter((m) => selected.has(m.id)).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Emails rotate across the selected inboxes, paced per inbox. Add a whole tag or
          domain at once, or pick inboxes individually.
        </p>
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {saving && <Loader2 size={11} className="animate-spin" />}
          {selectedCount} selected
        </span>
      </div>

      {/* Tag quick-add chips */}
      {sortedTags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Tags:</span>
          {sortedTags.map((g) => {
            const state = groupState(g.ids);
            return (
              <button
                key={g.label.toLowerCase()}
                type="button"
                disabled={disabled}
                onClick={() => toggleGroup(g.ids)}
                title={
                  state === "all"
                    ? `Remove all ${g.ids.length} “${g.label}” inboxes`
                    : `Add all ${g.ids.length} “${g.label}” inboxes`
                }
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  state === "all"
                    ? "border-[#2E37FE] bg-[#2E37FE] text-white"
                    : state === "some"
                      ? "border-[#2E37FE] bg-[#2E37FE]/10 text-[#2E37FE]"
                      : "border-border/60 text-secondary-foreground hover:border-[#2E37FE]/50"
                }`}
              >
                {state === "all" && <Check size={11} />}
                {g.label}
                <span className={state === "all" ? "text-white/80" : "text-muted-foreground"}>
                  {g.ids.length}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Individual inboxes grouped by domain, each with a select-all subheader */}
      <div className="space-y-3">
        {sortedDomains.map(([domain, ids]) => {
          const state = groupState(ids);
          const rows = selectable.filter((m) => ids.includes(m.id));
          return (
            <div key={domain} className="rounded-lg border border-border/50">
              <label className="flex cursor-pointer items-center gap-2 border-b border-border/50 bg-muted/30 px-3 py-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={state === "all"}
                  ref={(el) => {
                    if (el) el.indeterminate = state === "some";
                  }}
                  onChange={() => toggleGroup(ids)}
                  disabled={disabled}
                  className="h-3.5 w-3.5 accent-[#2E37FE]"
                />
                <span className="font-medium text-secondary-foreground">{domain}</span>
                <span className="text-muted-foreground">
                  {ids.length} inbox{ids.length === 1 ? "" : "es"}
                </span>
              </label>
              <div className="grid grid-cols-1 gap-px sm:grid-cols-2">
                {rows.map((mb) => (
                  <label
                    key={mb.id}
                    className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(mb.id)}
                      onChange={() => toggleOne(mb.id)}
                      disabled={disabled}
                      className="h-4 w-4 shrink-0 accent-[#2E37FE]"
                    />
                    <span className="min-w-0 flex-1 truncate">{mb.email_address}</span>
                    {(mb.tags ?? []).map((t) => (
                      <span
                        key={t}
                        className="hidden shrink-0 rounded-full bg-[#2E37FE]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#2E37FE] sm:inline"
                      >
                        {t}
                      </span>
                    ))}
                    {mb.status !== "active" && (
                      <span className="shrink-0 text-[10px] text-amber-600">{mb.status}</span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
