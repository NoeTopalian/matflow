"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// The lead funnel. A prospective gym who hits a blank error page here does
// not come back, so the copy gives them a way to reach a human instead.

export default function ApplyError({
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
      message="Something went wrong loading this form. Try again, or email hello@matflow.studio."
      className="px-4 py-12"
    />
  );
}
