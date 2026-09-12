"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Operator console. Only Noe sees this, so the copy can be blunt.

export default function AdminError({
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
      message="Operator console failed to load. Try again."
    />
  );
}
