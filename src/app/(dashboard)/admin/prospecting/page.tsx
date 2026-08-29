"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { LinkedInSearchPanel } from "./linkedin-search-panel";
import { MapsDiyPanel } from "./maps-diy-panel";

// Prospecting — two self-contained sourcing veins behind a tab switch:
//   • LinkedIn people (harvestapi profile search, by ICP)
//   • Business (Google Maps, by niche + location)
// Each panel owns its own state, polling, and CRM import. (The legacy Scrap.io
// business UI was retired here when its subscription was canceled; the Maps vein
// replaces it. Scrap.io client/routes remain for now — Phase 6 removes them.)
export default function ProspectingPage() {
  const [sourceMode, setSourceMode] = useState<"linkedin" | "business">("linkedin");

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Sparkles size={20} /> Prospecting
          </span>
        }
      />

      <div className="inline-flex rounded-lg border border-border/60 bg-muted/30 p-0.5">
        <button
          type="button"
          onClick={() => setSourceMode("linkedin")}
          className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            sourceMode === "linkedin" ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          LinkedIn people
        </button>
        <button
          type="button"
          onClick={() => setSourceMode("business")}
          className={`cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
            sourceMode === "business" ? "bg-background shadow-sm" : "text-muted-foreground"
          }`}
        >
          Business (Google Maps)
        </button>
      </div>

      {sourceMode === "linkedin" && <LinkedInSearchPanel />}
      {sourceMode === "business" && <MapsDiyPanel />}
    </div>
  );
}
