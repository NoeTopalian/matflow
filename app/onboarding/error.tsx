"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// A new club's first ten minutes with the product. The wizard already had a
// habit of advancing past failures; a boundary that says what happened is
// the opposite of that.

export default function OnboardingError({
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
      message="Something went wrong setting up your club. Your progress so far is saved — try again."
      className="px-4 py-12"
    />
  );
}
