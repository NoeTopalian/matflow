"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// The kiosk is a wall-mounted tablet in front of paying members, so this is
// the boundary that is seen by the most people and trusted by the club the
// most. An unbranded "Application error" here, mid-class, is the worst place
// in the product for one. Staff can also take the register by hand, which is
// what the copy points at rather than leaving someone tapping a dead screen.

export default function KioskError({
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
      message="Check-in isn't responding. Ask a coach to take your name — nothing is lost."
      className="px-4 py-12"
    />
  );
}
