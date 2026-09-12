"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Terms and privacy are linked from the signup flow and from emails, so a
// blank page here reads as a company that cannot keep its own policies up.

export default function LegalError({
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
      message="We couldn't load this page. Try again."
      className="px-4 py-12"
    />
  );
}
