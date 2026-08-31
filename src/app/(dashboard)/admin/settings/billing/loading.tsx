export default function BillingLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-28 rounded bg-muted/50" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl h-48 bg-muted/50" />
        ))}
      </div>
      <div className="rounded-xl h-64 bg-muted/50" />
    </div>
  );
}
