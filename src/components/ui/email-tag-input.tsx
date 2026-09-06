"use client";

import { useState } from "react";
import { X } from "lucide-react";

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Small tag-style multi-email input. Accepts comma, semicolon, Enter, or
// blur to commit the current buffer. Renders committed addresses as pills
// with an X button. Shared by the client settings "CC teammates" field and
// the first-login onboarding modal.
export function EmailTagInput({
  value,
  onChange,
  placeholder,
  max,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max: number;
  disabled?: boolean;
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
    if (value.includes(trimmed)) {
      setError("Already added.");
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
        className={`flex flex-wrap gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 py-2 min-h-[42px] ${
          disabled ? "opacity-60" : ""
        }`}
      >
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-full bg-[#2E37FE]/10 px-2.5 py-0.5 text-xs text-[#2E37FE]"
          >
            {email}
            <button
              type="button"
              onClick={() => !disabled && remove(email)}
              disabled={disabled}
              className="rounded-full hover:bg-[#2E37FE]/20 p-0.5 cursor-pointer disabled:cursor-not-allowed"
              aria-label={`Remove ${email}`}
            >
              <X size={10} />
            </button>
          </span>
        ))}
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
          disabled={disabled}
          className="flex-1 min-w-[140px] bg-transparent text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
