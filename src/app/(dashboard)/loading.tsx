export default function DashboardLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="rounded-xl h-32 bg-muted/50" />

      {/* Cards row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-xl h-40 bg-muted/50" />
        <div className="rounded-xl h-40 bg-muted/50" />
        <div className="rounded-xl h-40 bg-muted/50" />
      </div>

      {/* Content area */}
      <div className="rounded-xl h-64 bg-muted/50" />
    </div>
  );
}
