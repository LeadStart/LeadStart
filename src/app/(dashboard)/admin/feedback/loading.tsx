export default function FeedbackLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-8 w-40 rounded bg-muted/50" />
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="rounded-xl h-16 bg-muted/50" />
        ))}
      </div>
    </div>
  );
}
