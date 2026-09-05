"use client";

// Shared sending-mailbox picker for a campaign: used by the new-campaign builder
// and the campaign Setup tab. One unified type-to-search dropdown adds inboxes by
// TAG (named pools, alphabetical, on top) or individually; the current selection
// shows as removable chips. Under the dedicated-inbox policy, any tag/inbox already
// claimed by another campaign sinks to the bottom of the list, greyed with an
// "in use" pill, and can't be added (the server enforces the same rule).
// Presentational + controlled: the parent owns `selected` and saves it on its
// own Save button.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, Loader2, Lock, Plus, Search, X } from "lucide-react";

export interface PickerMailbox {
  id: string;
  email_address: string;
  status: string;
  tags: string[];
  // Dedicated-inbox policy: claimed by another non-completed campaign → not addable.
  inUse?: boolean;
  inUseBy?: string | null;
}

type TagRow = {
  kind: "tag";
  key: string;
  label: string;
  addableIds: string[]; // active + not-in-use inboxes carrying this tag
  total: number; // all active inboxes carrying this tag
  inUse: boolean; // nothing addable (every inbox is in use elsewhere)
};
type MbRow = { kind: "mb"; key: string; mb: PickerMailbox; inUse: boolean };
type Row = TagRow | MbRow;

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
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Addable set = active inboxes. Selected-but-inactive still render as chips so
  // they can be removed, but they aren't offered in the list.
  const listable = useMemo(
    () => mailboxes.filter((m) => m.status === "active"),
    [mailboxes],
  );

  // Tag rows from the listable inboxes (case-insensitive identity, first casing wins).
  const tagRows = useMemo<TagRow[]>(() => {
    const m = new Map<string, { label: string; ids: string[]; addable: string[] }>();
    for (const mb of listable) {
      for (const tag of mb.tags ?? []) {
        const key = tag.toLowerCase();
        const g = m.get(key) ?? { label: tag, ids: [], addable: [] };
        g.ids.push(mb.id);
        if (!mb.inUse) g.addable.push(mb.id);
        m.set(key, g);
      }
    }
    return [...m.entries()].map(([key, g]) => ({
      kind: "tag" as const,
      key,
      label: g.label,
      addableIds: g.addable,
      total: g.ids.length,
      inUse: g.addable.length === 0,
    }));
  }, [listable]);

  const selectedCount = useMemo(
    () => mailboxes.filter((m) => selected.has(m.id)).length,
    [mailboxes, selected],
  );

  if (mailboxes.filter((m) => m.status === "active" || selected.has(m.id)).length === 0) {
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

  function toggleTag(row: TagRow) {
    if (row.inUse) return;
    const allIn = row.addableIds.every((id) => selected.has(id));
    const next = new Set(selected);
    row.addableIds.forEach((id) => (allIn ? next.delete(id) : next.add(id)));
    onChange(next);
  }
  function toggleMb(mb: PickerMailbox) {
    if (mb.inUse && !selected.has(mb.id)) return;
    const next = new Set(selected);
    if (next.has(mb.id)) next.delete(mb.id);
    else next.add(mb.id);
    onChange(next);
  }
  function remove(id: string) {
    const next = new Set(selected);
    next.delete(id);
    onChange(next);
  }

  // Build the searched, sorted result list: available tags (alpha) → available
  // inboxes (alpha) → in-use tags (alpha) → in-use inboxes (alpha).
  const term = q.trim().toLowerCase();
  const tagsMatched = tagRows.filter((t) => t.label.toLowerCase().includes(term));
  const mbsMatched = listable.filter((m) => m.email_address.toLowerCase().includes(term));
  const alphaTag = (a: TagRow, b: TagRow) => a.label.localeCompare(b.label);
  const alphaMb = (a: PickerMailbox, b: PickerMailbox) =>
    a.email_address.localeCompare(b.email_address);

  const rows: Row[] = [
    ...tagsMatched.filter((t) => !t.inUse).sort(alphaTag),
    ...mbsMatched
      .filter((m) => !m.inUse)
      .sort(alphaMb)
      .map((mb) => ({ kind: "mb" as const, key: mb.id, mb, inUse: false })),
    ...tagsMatched.filter((t) => t.inUse).sort(alphaTag),
    ...mbsMatched
      .filter((m) => m.inUse)
      .sort(alphaMb)
      .map((mb) => ({ kind: "mb" as const, key: mb.id, mb, inUse: true })),
  ];

  const selectedList = mailboxes.filter((m) => selected.has(m.id));

  return (
    <div className="space-y-2.5">
      {/* Selected inboxes as removable chips */}
      <div className="flex min-h-[34px] flex-wrap items-center gap-2">
        {selectedList.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">No inboxes selected yet.</span>
        ) : (
          selectedList.map((m) => (
            <span
              key={m.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#2E37FE]/25 bg-[#2E37FE]/10 py-1 pl-2.5 pr-1 text-xs font-medium text-[#2E37FE]"
            >
              <span className="truncate">{m.email_address}</span>
              {m.status !== "active" && (
                <span className="text-[10px] text-amber-600">{m.status}</span>
              )}
              <button
                type="button"
                onClick={() => remove(m.id)}
                disabled={disabled}
                aria-label={`Remove ${m.email_address}`}
                className="grid h-4 w-4 place-items-center rounded-full hover:bg-[#2E37FE]/20 disabled:cursor-not-allowed"
              >
                <X size={11} />
              </button>
            </span>
          ))
        )}
      </div>

      {/* Add dropdown */}
      <div ref={ref} className="relative inline-block">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:border-[#2E37FE]/50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={13} /> Add inboxes or tags
          {selectedCount > 0 && (
            <span className="rounded-full bg-[#2E37FE]/10 px-1.5 text-[10px] text-[#2E37FE]">
              {selectedCount}
            </span>
          )}
          {saving && <Loader2 size={11} className="animate-spin text-muted-foreground" />}
          <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
        </button>

        {open && (
          <div className="absolute left-0 z-20 mt-1 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-background shadow-lg">
            <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
              <Search size={13} className="shrink-0 text-muted-foreground" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tags or inboxes…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
              />
            </div>
            <div className="max-h-72 overflow-y-auto p-1">
              {rows.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-muted-foreground">No matches.</p>
              ) : (
                rows.map((row) =>
                  row.kind === "tag" ? (
                    <TagOption
                      key={`t:${row.key}`}
                      row={row}
                      allSelected={row.addableIds.length > 0 && row.addableIds.every((id) => selected.has(id))}
                      someSelected={row.addableIds.some((id) => selected.has(id))}
                      onClick={() => toggleTag(row)}
                    />
                  ) : (
                    <MbOption
                      key={`m:${row.key}`}
                      mb={row.mb}
                      checked={selected.has(row.mb.id)}
                      inUse={row.inUse}
                      onClick={() => toggleMb(row.mb)}
                    />
                  ),
                )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Mark({ state }: { state: "on" | "some" | "off" }) {
  return (
    <span
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
        state === "on"
          ? "border-[#2E37FE] bg-[#2E37FE] text-white"
          : state === "some"
            ? "border-[#2E37FE] bg-[#2E37FE]/15"
            : "border-border"
      }`}
    >
      {state === "on" && <Check size={11} />}
      {state === "some" && <span className="h-1.5 w-1.5 rounded-[1px] bg-[#2E37FE]" />}
    </span>
  );
}

function InUsePill({ by }: { by?: string | null }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500"
      title={by ? `In use by ${by}` : "In use by another campaign"}
    >
      <Lock size={9} /> in use
    </span>
  );
}

function TagOption({
  row,
  allSelected,
  someSelected,
  onClick,
}: {
  row: TagRow;
  allSelected: boolean;
  someSelected: boolean;
  onClick: () => void;
}) {
  if (row.inUse) {
    return (
      <div className="flex cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-sm opacity-60">
        <Mark state="off" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">tag</span>
        <InUsePill />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60"
    >
      <Mark state={allSelected ? "on" : someSelected ? "some" : "off"} />
      <span className="min-w-0 flex-1 truncate font-medium">{row.label}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#2E37FE]">tag</span>
      <span className="shrink-0 text-xs text-muted-foreground">{row.addableIds.length}</span>
    </button>
  );
}

function MbOption({
  mb,
  checked,
  inUse,
  onClick,
}: {
  mb: PickerMailbox;
  checked: boolean;
  inUse: boolean;
  onClick: () => void;
}) {
  if (inUse) {
    return (
      <div className="flex cursor-not-allowed items-center gap-2 rounded px-2 py-1.5 text-sm opacity-60">
        <Mark state="off" />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{mb.email_address}</span>
        <InUsePill by={mb.inUseBy} />
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60"
    >
      <Mark state={checked ? "on" : "off"} />
      <span className="min-w-0 flex-1 truncate">{mb.email_address}</span>
      {(mb.tags ?? []).slice(0, 1).map((t) => (
        <span
          key={t}
          className="shrink-0 rounded-full bg-[#2E37FE]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#2E37FE]"
        >
          {t}
        </span>
      ))}
    </button>
  );
}
