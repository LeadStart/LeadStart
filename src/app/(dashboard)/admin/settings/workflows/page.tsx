"use client";

import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Workflow, Rocket, ArrowRight } from "lucide-react";

// Workflows section: one card per workflow. The workflows themselves still
// live at their own routes (the Flow Map and Onboarding preview are sync-
// guarded and full-bleed the canvas), so these cards link out to them rather
// than re-hosting them here.
const WORKFLOWS = [
  {
    href: "/admin/workflows",
    title: "Outbound pipeline",
    description:
      "The Enrichment Flow Map: both prospecting veins (Maps + LinkedIn) drawn as branching decision graphs on a pan-and-zoom canvas, so you can trace the whole sourcing and enrichment pipeline end to end.",
    icon: Workflow,
    color: "#2E37FE",
  },
  {
    href: "/admin/workflows/onboarding",
    title: "Onboarding",
    description:
      "A live preview of the real client-facing onboarding surfaces (the proposal email, the hosted quote page, and the welcome page) rendered from the live default config.",
    icon: Rocket,
    color: "#7c3aed",
  },
];

export default function SettingsWorkflowsPage() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {WORKFLOWS.map((wf) => {
        const Icon = wf.icon;
        return (
          <Card key={wf.href} className="flex flex-col border-border/50 shadow-sm">
            <CardHeader className="flex flex-row items-center gap-2 pb-3">
              <div
                className="flex h-8 w-8 items-center justify-center rounded-lg"
                style={{ background: wf.color }}
              >
                <Icon size={16} className="text-white" />
              </div>
              <CardTitle className="text-base">{wf.title}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col justify-between gap-4">
              <p className="text-sm text-muted-foreground">{wf.description}</p>
              <Link href={wf.href} className="block">
                <Button variant="outline" className="w-full">
                  Open {wf.title}
                  <ArrowRight size={14} className="ml-1" />
                </Button>
              </Link>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
