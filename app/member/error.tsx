"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Route-segment error boundary for the member portal (UI-RULES §7). The member
// shell is dark; ErrorState is token-driven, so it renders correctly here
// without polarity hacks.
//
// Shared implementation in components/SegmentErrorBoundary — the message and
// the padding are the only things that were ever different between segments.
export default function MemberError({
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
      message="Something went wrong. Your account is fine — try again."
      className="px-4 py-12"
    />
  );
}
