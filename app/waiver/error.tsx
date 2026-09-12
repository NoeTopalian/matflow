"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Waivers are signed at the door, usually on someone else's phone, by a
// person who is about to train. A failure must say plainly that nothing was
// signed — a half-signed waiver that nobody realises failed is the club's
// liability evidence quietly not existing.

export default function WaiverError({
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
      message="We couldn't load the waiver. Nothing has been signed — try again."
      className="px-4 py-12"
    />
  );
}
