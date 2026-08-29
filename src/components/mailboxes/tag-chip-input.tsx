"use client";

// A small chip-style tag input: existing tags render as removable chips, and a
// text field adds a tag on Enter / comma (or blur). Case-insensitive dedupe, and
// an optional suggestions list drives native autocomplete. Presentational — the
// parent owns the value and decides when to persist. Shared by the per-row tag
// editor and the bulk "tag selected" panel on Admin → Mailboxes.

import { useId, useState } from "react";
import { X } from "lucide-react";
import { MAX_TAG_LEN } from "@/lib/mailboxes/tags";

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
  const listId = useId();

  function addTag(raw: string) {
    const tag = raw.trim().slice(0, MAX_TAG_LEN);
    setDraft("");
    if (!tag) return;
    if (value.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...value, tag]);
  }

  function removeTag(tag: string) {
    onChange(value.filter((t) => t !== tag));
  }

  const remaining = suggestions.filter(
    (s) => !value.some((t) => t.toLowerCase() === s.toLowerCase()),
  );

  return (
    <div
      className={`flex flex-wrap items-center gap-1 rounded-md border border-border/60 bg-background px-1.5 py-1 text-sm ${
        disabled ? "opacity-60" : "focus-within:border-[#2E37FE]"
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
            onClick={() => removeTag(tag)}
            disabled={disabled}
            className="cursor-pointer rounded-full hover:bg-[#2E37FE]/20 disabled:cursor-not-allowed"
            aria-label={`Remove tag ${tag}`}
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        disabled={disabled}
        autoFocus={autoFocus}
        list={listId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addTag(draft);
          } else if (e.key === "Backspace" && !draft && value.length > 0) {
            removeTag(value[value.length - 1]);
          }
        }}
        onBlur={() => draft && addTag(draft)}
        placeholder={value.length === 0 ? placeholder : ""}
        className="min-w-[7rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground/60"
      />
      {remaining.length > 0 && (
        <datalist id={listId}>
          {remaining.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}
