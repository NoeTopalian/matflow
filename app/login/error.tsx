"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// The front door. A failure here locks everyone out of everything, so the
// retry is the whole point — and the reference is what an owner reads out
// when they ring to say they cannot get in.

export default function LoginError({
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
      message="We couldn't load the sign-in page. Try again."
      className="px-4 py-12"
    />
  );
}
