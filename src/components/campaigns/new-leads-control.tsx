"use client";

// "New contacts per day" for a campaign's schedule (campaigns.daily_new_leads_cap):
// no limit (NULL, the default), a deliberate limit, or paused (0). Under "Finish
// the sequence first" every send tick sends the due follow-ups before any new
// contact, so no limit already keeps every contact on schedule; a limit only
// slows a campaign on purpose. Rules: resolveDailyNewLeadsCap in src/lib/gmail/ramp.ts.

import { useState } from "react";
import type { SendingStrategy } from "@/types/app";

type Mode = "none" | "limit" | "paused";

const MODES: { value: Mode; label: string }[] = [
  { value: "none", label: "No limit" },
  { value: "limit", label: "Limit" },
  { value: "paused", label: "Paused" },
];

// What "Limit" starts at when it's switched on with no number yet.
const FIRST_LIMIT = 20;

function modeOf(cap: number | null): Mode {
  if (cap == null) return "none";
  return cap === 0 ? "paused" : "limit";
}

/** One-line summary for read-only headers ("no limit on new contacts"). */
export function newLeadsSummary(cap: number | null): string {
  if (cap == null) return "no limit on new contacts";
  if (cap === 0) return "new contacts paused";
  return `up to ${cap} new contact${cap === 1 ? "" : "s"}/day`;
}

export function NewLeadsControl({
  value,
  onChange,
  strategy,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  strategy: SendingStrategy;
}) {
  const mode = modeOf(value);
  const [lastLimit, setLastLimit] = useState<number>(value != null && value > 0 ? value : FIRST_LIMIT);
  const [draft, setDraft] = useState(String(value != null && value > 0 ? value : FIRST_LIMIT));

  const pick = (m: Mode) => {
    if (m === "limit") setDraft(String(lastLimit));
    onChange(m === "none" ? null : m === "paused" ? 0 : lastLimit);
  };

  const hint =
    mode === "paused"
      ? "No new contacts start. Contacts already in the sequence keep getting their follow-ups."
      : strategy === "reach_first"
        ? mode === "limit"
          ? "Reach everyone first ignores a limit: new contacts use full inbox capacity. Only Paused applies here."
          : "New contacts use full inbox capacity."
        : mode === "none"
          ? "Due follow-ups always go first; new contacts fill whatever inbox capacity is left, so everyone gets each email on schedule."
          : `At most ${value} new contacts start each day. Use a limit only to slow a campaign on purpose: follow-ups go first either way.`;

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-secondary-foreground">New contacts per day</p>
      <div className="flex flex-wrap items-center gap-2">
        <div role="radiogroup" aria-label="New contacts per day" className="inline-flex rounded-lg border border-border/60 bg-muted/40 p-0.5">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => pick(m.value)}
              className={`cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === m.value ? "bg-[#2E37FE] text-white" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        {mode === "limit" && (
          <input
            type="number"
            min={1}
            max={1000}
            value={draft}
            aria-label="New contacts per day limit"
            onChange={(e) => {
              setDraft(e.target.value);
              const n = Math.floor(Number(e.target.value));
              if (e.target.value.trim() === "" || !Number.isFinite(n) || n < 1) return;
              const v = Math.min(1000, n);
              setLastLimit(v);
              onChange(v);
            }}
            className="w-24 rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm"
          />
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
    </div>
  );
}
