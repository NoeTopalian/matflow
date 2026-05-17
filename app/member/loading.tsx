// Route-level Suspense fallback for the member surface — the layout chrome
// stays visible while the page's server component fetches data.
export default function MemberLoading() {
  return (
    <div className="space-y-4 animate-pulse" aria-hidden>
      <div className="h-16 rounded-xl" style={{ background: "var(--sf-1)" }} />
      <div className="h-32 rounded-xl" style={{ background: "var(--sf-1)" }} />
      <div className="h-64 rounded-xl" style={{ background: "var(--sf-1)" }} />
    </div>
  );
}
