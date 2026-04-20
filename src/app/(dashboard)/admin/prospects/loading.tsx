export default function ProspectsLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="rounded-[20px] h-28 bg-muted/50" />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl h-24 bg-muted/50" />
        ))}
      </div>
      <div className="flex gap-4 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="w-[280px] shrink-0 rounded-xl h-80 bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
