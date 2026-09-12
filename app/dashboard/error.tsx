"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Route-segment error boundary (UI-RULES §7): a render/data failure on any
// dashboard page shows a retryable error, never a blank screen — and never an
// empty state that a database outage could impersonate.
//
// The logic moved to components/SegmentErrorBoundary so that the eleven
// segments now carrying one cannot drift apart. See that file for why the
// reference is derived from `error.digest` and why a client-side error has none.
export default function DashboardError({
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
      message="Something went wrong loading this page. Your data is safe — try again."
    />
  );
}
