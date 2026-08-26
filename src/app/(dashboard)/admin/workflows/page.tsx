export const metadata = { title: "Workflows — LeadStart" };

// Workflows — reference diagrams of how LeadStart runs, embedded as isolated,
// self-contained docs. The doc is the full Enrichment Flow Map (front doors →
// enrichment run → waterfall routing → send/LinkedIn split → replies, with
// cadence + unit costs), forced light via data-theme on the doc itself to match
// the light admin shell. Negative margins cancel the shell's <main> padding so
// it bleeds to the content edges; keep the same file in sync with the published
// artifact copy when either changes.
export default function WorkflowsPage() {
  return (
    <div className="-m-4 sm:-m-6" style={{ background: "#f7f8fc" }}>
      <iframe
        src="/app/workflows/outbound-pipeline.html"
        title="Outbound pipeline — prospecting, enrichment, send & replies"
        style={{ border: 0, width: "100%", height: "calc(100vh - 3.5rem)", display: "block" }}
      />
    </div>
  );
}
