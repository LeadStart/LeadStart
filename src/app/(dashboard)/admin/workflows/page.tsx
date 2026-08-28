import { EnrichmentFlowMap } from "@/components/workflows/enrichment-flow-map";

export const metadata = { title: "Workflows — LeadStart" };

// Workflows — the Enrichment Flow Map. The two prospecting veins (LinkedIn +
// Maps) drawn as branching decision graphs on the same dotted, grab-to-pan
// canvas as the campaign flow editor, so you can drag around to see the whole
// pipeline. Rendered client-side (the canvas panning needs the browser); the
// old self-contained outbound-pipeline.html doc is no longer wired in.
export default function WorkflowsPage() {
  return (
    <div className="-m-4 sm:-m-6">
      <EnrichmentFlowMap />
    </div>
  );
}
