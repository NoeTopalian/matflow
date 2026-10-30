"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// T9c public club page. A failed read is an honest error with a reference
// (instrumentation.ts onRequestError logs the same one), never an empty page
// that would read as "this club has no timetable".

export default function ClubPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <SegmentErrorBoundary
      error={error}
      reset={reset}
      message="Something went wrong loading this club's page. Try again in a moment."
      className="px-4 py-12"
    />
  );
}
