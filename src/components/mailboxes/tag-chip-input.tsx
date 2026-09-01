"use client";

// A chip-style tag input with a REAL match-as-you-type dropdown (not a native
// <datalist>, which opens unreliably and never forces a match). Existing tags
// render as removable chips; typing filters the org's existing tags so you reuse
// one instead of free-typing a near-duplicate. Selecting an existing tag adopts
// its canonical casing, so "client a" can never fragment "Client A". Creating a
// brand-new tag is still possible, but as a clearly-separate action rather than
// the default. Presentational — the parent owns the value and decides when to
// persist. Shared by the per-row tag editor and the bulk "tag selected" panel on
// Admin → Mailboxes. Mirrors the campaign MailboxPoolPicker's combobox pattern.

import { useEffect, useId, useRef, useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { MAX_TAG_LEN } from "@/lib/mailboxes/tags";

type Option =
  | { kind: "existing"; label: string }
  | { kind: "create"; label: string };

export function TagChipInput({
  value,
  onChange,
  suggestions = [],
  placeholder = "Add tag…",
  disabled = false,
  autoFocus = false,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0); // highlighted option index
  const [navigated, setNavigated] = useState(false); // user moved via arrows
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  const has = (tag: string) => value.some((t) => t.toLowerCase() === tag.toLowerCase());

  // Existing org tags not already added, filtered by the draft (case-insensitive).
  const term = draft.trim().toLowerCase();
  const matches = suggestions.filter((s) => !has(s) && s.toLowerCase().includes(term));

  // Offer "Create <draft>" only when the draft is a genuinely new tag (not an
  // existing suggestion and not already an added chip).
  const trimmed = draft.trim().slice(0, MAX_TAG_LEN);
  const exactExists =
    !!trimmed &&
    (has(trimmed) || suggestions.some((s) => s.toLowerCase() === trimmed.toLowerCase()));
  const showCreate = !!trimmed && !exactExists;

  const options: Option[] = [
    ...matches.map((label) => ({ kind: "existing" as const, label })),
    ...(showCreate ? [{ kind: "create" as const, label: trimmed }] : []),
  ];
  const panelOpen = open && !disabled && options.length > 0;
  // Clamp the highlight at render so a shrinking filtered list can never point
  // past the end (no state-sync effect needed).
  const safeActive = options.length ? Math.min(active, options.length - 1) : 0;

  // Close the panel on a click outside the component.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function addTag(raw: string) {
    // Adopt an existing tag's canonical casing when the text matches one
    // case-insensitively, so casing/typos never fragment a pool.
    const key = raw.trim().toLowerCase();
    const canon =
      suggestions.find((s) => s.toLowerCase() === key) ??
      value.find((t) => t.toLowerCase() === key);
    const tag = (canon ?? raw).trim().slice(0, MAX_TAG_LEN);
    setDraft("");
    setActive(0);
    setNavigated(false);
    if (!tag || has(tag)) return;
    onChange([...value, tag]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  // Enter/comma commits, but never on an empty field unless the user has
  // explicitly arrowed onto a row — so auto-opening the list can't add a tag by
  // accident.
  function commitFromKey() {
    if (!trimmed && !navigated) return;
    if (options.length > 0) addTag(options[safeActive].label);
    else if (trimmed) addTag(trimmed);
  }

  const showHighlight = trimmed.length > 0 || navigated;

  return (
    <div ref={wrapRef} className="relative">
      <div
        onClick={() => {
          if (disabled) return;
          inputRef.current?.focus();
          setOpen(true);
        }}
        className={`flex flex-wrap items-center gap-1 rounded-md border border-border/60 bg-background px-1.5 py-1 text-sm ${
          disabled ? "opacity-60" : "cursor-text focus-within:border-[#2E37FE]"
        }`}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-[#2E37FE]/10 px-2 py-0.5 text-xs font-medium text-[#2E37FE]"
          >
            {tag}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(tag);
              }}
              disabled={disabled}
              className="cursor-pointer rounded-full hover:bg-[#2E37FE]/20 disabled:cursor-not-allowed"
              aria-label={`Remove tag ${tag}`}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          value={draft}
          disabled={disabled}
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={panelOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
            setNavigated(false);
            setOpen(true);
          }}
          onBlur={() => {
            // Commit a typed-but-un-Entered tag when focus truly leaves (e.g.
            // clicking Save). Option clicks preventDefault their mousedown, so
            // they never blur the input and never double-add here.
            if (draft.trim()) addTag(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              if (trimmed || navigated) {
                e.preventDefault();
                commitFromKey();
              }
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setNavigated(true);
              setActive((i) => (options.length ? (i + 1) % options.length : 0));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setOpen(true);
              setNavigated(true);
              setActive((i) => (options.length ? (i - 1 + options.length) % options.length : 0));
            } else if (e.key === "Escape") {
              if (open) {
                e.stopPropagation();
                setOpen(false);
              }
            } else if (e.key === "Backspace" && !draft && value.length > 0) {
              removeTag(value[value.length - 1]);
            }
          }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="min-w-[7rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </div>

      {panelOpen && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 z-30 mt-1 max-h-56 w-full min-w-[13rem] overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-background p-1 shadow-lg"
        >
          {matches.length > 0 && (
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Existing tags
            </div>
          )}
          {options.map((opt, i) => {
            const highlit = i === safeActive && showHighlight;
            return (
              <button
                key={`${opt.kind}:${opt.label}`}
                type="button"
                role="option"
                aria-selected={highlit}
                // Keep focus on the input so the panel doesn't close before the
                // click registers, and so onBlur never fires from a selection.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => {
                  setActive(i);
                  setNavigated(true);
                }}
                onClick={() => addTag(opt.label)}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                  highlit ? "bg-muted/70" : "hover:bg-muted/60"
                }`}
              >
                {opt.kind === "create" ? (
                  <>
                    <Plus size={13} className="shrink-0 text-[#2E37FE]" />
                    <span className="min-w-0 flex-1 truncate">
                      Create <span className="font-medium">“{opt.label}”</span>
                    </span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-[#2E37FE]">
                      new
                    </span>
                  </>
                ) : (
                  <>
                    <Check size={13} className="shrink-0 text-muted-foreground/40" />
                    <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      tag
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
