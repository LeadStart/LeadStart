// Shared "$29/mo Apify plan floor" disclosure (SPEND-26). Every pre-run cost
// surface (LinkedIn search, Maps DIY, the Contacts enrich dialog) shows the same
// wording so the plan minimum is disclosed once, consistently. The per-result
// estimates draw against a prepaid monthly balance that does not roll over, so a
// light month still bills the floor.

export function PlanFloorNote({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-md border border-border bg-muted/40 px-2.5 py-2 text-[11px] ${className ?? ""}`}
    >
      <p className="font-medium text-foreground">Plus your Apify plan&apos;s monthly minimum</p>
      <p className="mt-0.5">
        These are usage charges that draw against your Apify plan&apos;s prepaid balance
        (Starter = <span className="font-mono">$29</span>/mo). That minimum is a floor, not
        additive per run, but it{" "}
        <span className="font-medium text-foreground">doesn&apos;t roll over</span>, so a light
        month still bills $29. Residential proxy and compute are already bundled into the
        per-result prices, so there&apos;s no separate proxy or compute-unit line.
      </p>
    </div>
  );
}
