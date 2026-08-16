// Route-level Suspense fallback for the member surface — the layout chrome
// stays visible while the page's server component fetches data.
// The member shell is canonically dark (docs/UI-RULES.md §1), so the shimmer
// blocks are white-alpha — NOT --sf-1, which is white on the light root scale
// and previously painted solid white bars over the #111111 background.
export default function MemberLoading() {
  return (
    // px-4 pt-4 matches the real pages' padding so the shimmer doesn't run
    // edge-to-edge and jump on swap (audit U6).
    <div className="space-y-4 animate-pulse px-4 pt-4" aria-hidden>
      <div className="h-16 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
      <div className="h-32 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
      <div className="h-64 rounded-xl" style={{ background: "rgba(255,255,255,0.06)" }} />
    </div>
  );
}
