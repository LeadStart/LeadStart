export default function ClientLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="rounded-xl h-36 bg-muted/50" />
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl h-28 bg-muted/50" />
        ))}
      </div>
      <div className="rounded-xl h-64 bg-muted/50" />
    </div>
  );
}
