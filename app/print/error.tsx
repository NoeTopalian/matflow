"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// The card sheet opens in its own tab with no dashboard chrome to navigate
// back with, so without a boundary a failure here is a dead tab.

export default function PrintError({
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
      message="We couldn't build the card sheet. Nothing has been printed — try again."
      className="px-4 py-12"
    />
  );
}
