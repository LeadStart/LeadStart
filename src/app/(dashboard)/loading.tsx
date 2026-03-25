export default function DashboardLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      {/* Header skeleton */}
      <div className="rounded-xl p-6 h-28" style={{ background: 'linear-gradient(135deg, #4f46e5, #7c3aed, #6366f1)', opacity: 0.7 }}>
        <div className="h-3 w-32 bg-white/20 rounded mb-3" />
        <div className="h-6 w-48 bg-white/30 rounded mb-2" />
        <div className="h-3 w-64 bg-white/15 rounded" />
      </div>

      {/* Card skeletons */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-border/50 bg-card p-5 space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-muted" />
              <div className="space-y-1.5 flex-1">
                <div className="h-4 w-28 bg-muted rounded" />
                <div className="h-3 w-20 bg-muted/60 rounded" />
              </div>
            </div>
            <div className="h-px bg-border/50" />
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map((j) => (
                <div key={j} className="text-center space-y-1">
                  <div className="h-4 w-10 bg-muted rounded mx-auto" />
                  <div className="h-2.5 w-8 bg-muted/50 rounded mx-auto" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
