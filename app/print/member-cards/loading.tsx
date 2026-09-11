// Route-level Suspense fallback (UI-RULES §7). The page runs two queries
// inside a transaction — and a third when the card cap bites — before it can
// paint anything, so without this the browser sits on the previous screen
// after staff have already clicked.
//
// Light polarity: /print is a STAFF surface, so the shimmer uses --sf-1 like
// the dashboard's, not the member shell's white-alpha blocks (§1). The shapes
// mirror what resolves into them: the toolbar row, then one A4 sheet.
export default function PrintMemberCardsLoading() {
  return (
    <div className="animate-pulse px-6 py-5" aria-hidden>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-2">
          <div className="h-6 w-40 rounded-[var(--r-sm)]" style={{ background: "var(--sf-1)" }} />
          <div className="h-4 w-72 rounded-[var(--r-sm)]" style={{ background: "var(--sf-1)" }} />
        </div>
        <div className="h-10 w-28 rounded-[var(--r-md)]" style={{ background: "var(--sf-1)" }} />
      </div>
      <div
        className="mx-auto mt-6 rounded-[var(--r-md)]"
        style={{ width: "210mm", maxWidth: "100%", height: "297mm", background: "var(--sf-1)" }}
      />
    </div>
  );
}
