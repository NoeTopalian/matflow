// Route-level Suspense fallback. Next.js renders this in the layout's
// <main> slot while any /dashboard page server-component is still
// fetching, so the sidebar / topbar / mobile nav remain interactive and
// the user sees an immediate response to navigation instead of waiting
// for the page's data to resolve.
export default function DashboardLoading() {
  return (
    <div className="max-w-6xl mx-auto space-y-6 animate-pulse" aria-hidden>
      <div className="h-20 rounded-xl" style={{ background: "var(--sf-1)" }} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 rounded-xl" style={{ background: "var(--sf-1)" }} />
        ))}
      </div>
      <div className="h-96 rounded-xl" style={{ background: "var(--sf-1)" }} />
    </div>
  );
}
