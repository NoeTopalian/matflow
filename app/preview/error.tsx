"use client";

import SegmentErrorBoundary from "@/components/SegmentErrorBoundary";

// Internal branding preview.

export default function PreviewError({
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
      message="We couldn't load the preview. Try again."
      className="px-4 py-12"
    />
  );
}
