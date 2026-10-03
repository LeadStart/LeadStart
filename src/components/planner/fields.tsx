"use client";

// Small form + result building blocks for the Campaign Planner. Flat contract
// (UI_RULES.md): hairline borders + tint, token classes, no shadows.

import { useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export function Section({
  title,
  icon,
  children,
  className,
}: {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card p-4 space-y-3", className)}>
      <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

export function Hint({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("text-[11px] leading-snug text-muted-foreground", className)}>{children}</p>;
}

/**
 * A number box that lets the field be cleared while typing: the draft string is
 * local, and only a finite number (clamped) is committed. `nullable` fields
 * commit null when emptied (e.g. "no domain cap").
 */
export function NumField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  prefix,
  suffix,
  hint,
  nullable,
  placeholder,
  integer,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  prefix?: string;
  suffix?: string;
  hint?: React.ReactNode;
  nullable?: boolean;
  placeholder?: string;
  integer?: boolean;
}) {
  const id = useId();
  const shown = value == null ? "" : String(value);
  const [draft, setDraft] = useState(shown);
  // Re-sync the box only when the value changes from outside (a reset, a
  // clamp, "use N domains"), never while what's typed already means the
  // same number, or "0.0" on the way to "0.08" would snap back to "0".
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    if (!(draft.trim() !== "" && Number(draft) === value)) setDraft(shown);
  }
  const commit = (raw: string) => {
    if (raw.trim() === "") {
      if (nullable) onChange(null);
      return;
    }
    let n = Number(raw);
    if (!Number.isFinite(n)) return;
    if (integer) n = Math.floor(n);
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    onChange(n);
  };
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <div className="relative">
        {prefix && (
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
            {prefix}
          </span>
        )}
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={draft}
          min={min}
          max={max}
          step={step ?? (integer ? 1 : "any")}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setDraft(shown)}
          className={cn("h-9 tabular-nums", prefix && "pl-6", suffix && "pr-12")}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {suffix}
          </span>
        )}
      </div>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export function DateField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input
        id={id}
        type="date"
        value={value}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        className="h-9 tabular-nums"
      />
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  hint?: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => {
          const hit = options.find((o) => String(o.value) === e.target.value);
          if (hit) onChange(hit.value);
        }}
        className="h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-input px-2.5 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-primary"
        />
        {label}
      </label>
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

/** Two-to-four option segmented control. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex w-full rounded-lg border bg-muted/40 p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

type Tone = "info" | "warn" | "danger" | "success";
const TONES: Record<Tone, string> = {
  info: "border-primary/20 bg-primary/5 text-foreground",
  warn: "border-amber-200 bg-amber-50 text-amber-900",
  danger: "border-red-200 bg-red-50 text-red-900",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
};

export function Callout({
  tone = "info",
  icon,
  children,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex gap-2.5 rounded-lg border p-3 text-sm leading-relaxed", TONES[tone])}>
      {icon && <span className="mt-0.5 shrink-0">{icon}</span>}
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}
