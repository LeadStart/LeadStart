export default function ProspectsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="h-8 w-36 rounded bg-muted/50" />
        <div className="h-10 w-32 rounded bg-muted/50" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl h-64 bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
