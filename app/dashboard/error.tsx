"use client";

import { useEffect, useMemo } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";
import { errorReferenceFromDigest } from "@/lib/error-reference";

// Route-segment error boundary (UI-RULES §7): a render/data failure on any
// dashboard page shows a retryable error, never a blank screen — and never an
// empty state that a DB outage could impersonate.
//
// `error.digest` is the only thing Next ships to the browser about a server
// error. Hashing it here produces exactly the reference that
// `instrumentation.ts`'s onRequestError already wrote into the server log
// beside the real stack, so what the owner reads on screen is searchable.
// A client-side render error has no digest and therefore no reference —
// there is no server log line to point at, and inventing one would be a lie.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const reference = useMemo(
    () => (error.digest ? errorReferenceFromDigest(error.digest) : null),
    [error.digest],
  );

  useEffect(() => {
    Sentry.withScope((scope) => {
      if (reference) scope.setTag("error_reference", reference);
      Sentry.captureException(error);
    });
  }, [error, reference]);

  return (
    <div className="py-12">
      <ErrorState
        message="Something went wrong loading this page. Your data is safe — try again."
        reference={reference}
        onRetry={reset}
      />
    </div>
  );
}
