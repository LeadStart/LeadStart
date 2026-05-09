export default function InboxLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="rounded-xl h-28 bg-muted/50" />
      <div className="grid grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl h-24 bg-muted/50" />
        ))}
      </div>
      <div className="space-y-3">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="rounded-xl h-16 bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
