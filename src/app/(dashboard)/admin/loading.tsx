export default function AdminLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Banner skeleton */}
      <div className="rounded-xl h-36 bg-muted/50" />

      {/* Client cards */}
      <div className="space-y-4">
        <div className="rounded-xl h-44 bg-muted/50" />
        <div className="rounded-xl h-44 bg-muted/50" />
        <div className="rounded-xl h-44 bg-muted/50" />
      </div>
    </div>
  );
}
