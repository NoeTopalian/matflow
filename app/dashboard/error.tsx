"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";

// Route-segment error boundary (UI-RULES §7): a render/data failure on any
// dashboard page shows a retryable error, never a blank screen — and never an
// empty state that a DB outage could impersonate.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <div className="py-12">
      <ErrorState
        message="Something went wrong loading this page. Your data is safe — try again."
        onRetry={reset}
      />
    </div>
  );
}
