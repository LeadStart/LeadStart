export const metadata = { title: "Workflows — LeadStart" };

// Workflows — reference diagrams of how LeadStart runs, embedded as isolated,
// self-contained docs. Each carries its own LeadStart-branded dark hero, so the
// tab renders edge-to-edge with no separate app heading. The negative margins
// cancel the shell's <main> padding so the dark doc bleeds to the content edges
// (it's forced to dark via data-theme on the doc itself, matching the artifact).
export default function WorkflowsPage() {
  return (
    <div className="-m-4 sm:-m-6" style={{ background: "#0a0e1c" }}>
      <iframe
        src="/app/workflows/outbound-pipeline.html"
        title="Outbound pipeline — Apify actors by stage"
        style={{ border: 0, width: "100%", height: "calc(100vh - 3.5rem)", display: "block" }}
      />
    </div>
  );
}
