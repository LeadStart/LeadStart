"use client";

import { useState } from "react";
import { Sparkles, MapPin, Users, Upload, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { LinkedInSearchPanel } from "./linkedin-search-panel";
import { MapsDiyPanel } from "./maps-diy-panel";

// Prospecting: the entry is a framed "decision list": the operator picks WHO
// they're chasing before a panel loads, rather than flipping a filter-style tab.
// Two live sourcing veins behind the choice:
//   • Local businesses: Google Maps, by niche + location (MapsDiyPanel)
//   • People by role  : harvestapi profile search, by ICP (LinkedInSearchPanel)
// A third door, "Enrich a list" (bring-your-own-list, no sourcing), is shown as
// a not-yet-active option: the enrich-only lane isn't built. Once a vein is
// chosen the page title becomes that vein and a circular back arrow (left of
// the title) returns to this decision list.
type SourceMode = "linkedin" | "business";

export default function ProspectingPage() {
  // null = show the decision list (the framed choice on landing).
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            {sourceMode === null ? (
              <>
                <Sparkles size={20} /> Prospecting
              </>
            ) : (
              <>
                {sourceMode === "business" ? <MapPin size={20} /> : <Users size={20} />}
                {sourceMode === "business" ? "Local businesses" : "People by role"}
                {/* Source provenance, kept next to the title (not in `actions`,
                    where a full-width header strands it at the far right). */}
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                  {sourceMode === "business" ? "Google Maps" : "LinkedIn"}
                </span>
              </>
            )}
          </span>
        }
        onBack={sourceMode === null ? undefined : () => setSourceMode(null)}
        backLabel="Back to prospecting sources"
      />

      {sourceMode === null ? (
        <DecisionList onSelect={setSourceMode} />
      ) : (
        <>
          {sourceMode === "linkedin" && <LinkedInSearchPanel />}
          {sourceMode === "business" && <MapsDiyPanel />}
        </>
      )}
    </div>
  );
}

// ── Decision list ──────────────────────────────────────────────────────────
// Two live search veins as rich, self-explaining rows, then a set-apart
// "Enrich a list" door (not yet active).
function DecisionList({ onSelect }: { onSelect: (mode: SourceMode) => void }) {
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">Pick a starting point.</p>

      <div className="flex flex-col gap-2.5">
        <SearchRow
          icon={<MapPin size={20} />}
          iconClass="bg-brand-50 text-primary"
          title="Local businesses"
          tag="Google Maps"
          desc="Businesses you'd find on a map, sourced by trade and location."
          example="e.g. Cleaning companies in Phoenix · Med spas in Austin → business, phone, best email"
          onClick={() => onSelect("business")}
        />
        <SearchRow
          icon={<Users size={20} />}
          iconClass="bg-violet-50 text-violet-600"
          title="People by role"
          tag="LinkedIn"
          desc="Specific decision-makers, sourced by job title and company profile."
          example="e.g. Marketing directors at SaaS · Owners of 10-50 person agencies → named person, work email"
          onClick={() => onSelect("linkedin")}
        />

        <div className="mt-1 flex items-center gap-3 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="h-px flex-1 bg-border" />
          Already have a list
          <span className="h-px flex-1 bg-border" />
        </div>

        {/* Enrich-only lane: not built yet, so this door is present but inert. */}
        <div
          aria-disabled="true"
          className="flex cursor-not-allowed items-center gap-4 rounded-xl border border-dashed border-border bg-muted/20 p-4"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <Upload size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold text-foreground/80">Enrich a list</span>
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                Soon
              </span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-muted-foreground">
              Upload companies or names and we find the emails. Priced lower per contact.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchRow({
  icon,
  iconClass,
  title,
  tag,
  desc,
  example,
  onClick,
}: {
  icon: React.ReactNode;
  iconClass: string;
  title: string;
  tag: string;
  desc: string;
  example: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-4 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-slate-300"
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconClass}`}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold">{title}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {tag}
          </span>
        </div>
        <p className="mt-0.5 text-[12.5px] text-muted-foreground">{desc}</p>
        <p className="mt-1.5 text-xs text-secondary-foreground">{example}</p>
      </div>
      <ArrowRight
        size={20}
        className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </button>
  );
}
