export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg bg-white/5 ${className}`}
      aria-hidden="true"
    />
  );
}

export function CalendarSkeleton() {
  return (
    <div className="max-w-6xl mx-auto" aria-label="Loading calendar..." aria-busy="true">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </div>

      {/* Week nav */}
      <div className="flex items-center gap-2 mb-4">
        <Skeleton className="w-8 h-8 rounded-lg" />
        <Skeleton className="w-8 h-8 rounded-lg" />
        <Skeleton className="h-5 w-52 ml-1" />
        <Skeleton className="h-8 w-16 rounded-lg ml-auto" />
      </div>

      {/* Desktop grid */}
      <div className="hidden md:grid grid-cols-7 gap-2 mb-6">
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/2 min-h-[140px] p-2.5">
            <Skeleton className="h-3 w-8 mb-2" />
            <Skeleton className="h-7 w-7 mb-3 rounded-full" />
            <Skeleton className="h-10 w-full rounded-lg mb-1" />
            {i % 3 === 0 && <Skeleton className="h-10 w-full rounded-lg" />}
          </div>
        ))}
      </div>

      {/* Mobile day pills */}
      <div className="flex gap-2 md:hidden mb-5 overflow-hidden">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="w-14 h-16 rounded-2xl flex-shrink-0" />
        ))}
      </div>

      {/* Day detail */}
      <div className="space-y-2">
        <div className="flex justify-between mb-3">
          <Skeleton className="h-5 w-36" />
          <Skeleton className="h-4 w-16" />
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-white/5 bg-white/2 p-4 flex items-center gap-3">
            <Skeleton className="w-1 h-12 rounded-full flex-shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
            <Skeleton className="h-8 w-20 rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}
