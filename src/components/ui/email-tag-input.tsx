"use client";

import { useState } from "react";
import { X } from "lucide-react";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Small tag-style multi-email input. Accepts comma, semicolon, Enter, or
// blur to commit the current buffer. Renders committed addresses as pills
// with an X button. Shared by the client settings "CC teammates" field, the
// first-login onboarding modal and the admin Inbox reply's To / Cc / Bcc.
// `describe` names a pill (shown instead of the address, which stays its
// tooltip) or tags it; `taken` lists addresses already in a sibling field.
export function EmailTagInput({
  value,
  onChange,
  placeholder,
  max,
  disabled,
  label,
  describe,
  taken,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max: number;
  disabled?: boolean;
  /** The text field's accessible name. */
  label?: string;
  describe?: (email: string) => { name?: string; tag?: string } | undefined;
  taken?: string[];
}) {
  const [buffer, setBuffer] = useState("");
  const [error, setError] = useState<string | null>(null);

  function commit(raw: string) {
    const trimmed = raw.trim().toLowerCase().replace(/[,;]\s*$/, "");
    if (!trimmed) {
      setBuffer("");
      return;
    }
    if (!EMAIL_SHAPE.test(trimmed)) {
      setError(`"${raw.trim()}" isn't a valid email.`);
      return;
    }
    if (value.some((v) => v.toLowerCase() === trimmed)) {
      setError("Already added.");
      return;
    }
    if (taken?.some((v) => v.toLowerCase() === trimmed)) {
      setError("Already on this reply.");
      return;
    }
    if (value.length >= max) {
      setError(`Max ${max} addresses.`);
      return;
    }
    onChange([...value, trimmed]);
    setBuffer("");
    setError(null);
  }

  function remove(email: string) {
    onChange(value.filter((e) => e !== email));
  }

  return (
    <div className="space-y-1.5">
      <div
        className={`flex flex-wrap gap-1.5 rounded-xl border border-input bg-card px-3 py-2 min-h-[42px] shadow-[0_1px_3px_rgba(0,0,0,0.06)] focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15 ${
          disabled ? "opacity-60" : ""
        }`}
      >
        {value.map((email) => {
          const about = describe?.(email);
          return (
            <span
              key={email}
              title={about?.name ? email : undefined}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-500"
            >
              <span className="truncate">{about?.name || email}</span>
              {about?.tag && (
                <span className="shrink-0 rounded-full bg-card px-1.5 text-[10px] font-semibold text-slate-600">
                  {about.tag}
                </span>
              )}
              <button
                type="button"
                onClick={() => !disabled && remove(email)}
                disabled={disabled}
                className="rounded-full hover:bg-primary/15 p-0.5 cursor-pointer disabled:cursor-not-allowed"
                aria-label={`Remove ${email}`}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        <input
          type="email"
          value={buffer}
          onChange={(e) => {
            setBuffer(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === ";") {
              e.preventDefault();
              commit(buffer);
            } else if (e.key === "Backspace" && buffer === "" && value.length > 0) {
              remove(value[value.length - 1]);
            }
          }}
          onBlur={() => buffer && commit(buffer)}
          placeholder={value.length === 0 ? placeholder : ""}
          aria-label={label}
          disabled={disabled}
          className="flex-1 min-w-[140px] bg-transparent text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
