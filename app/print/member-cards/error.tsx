"use client";

import { useEffect, useMemo } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";
import { errorReferenceFromDigest } from "@/lib/error-reference";

// Route-segment error boundary (UI-RULES §7). The page deliberately does not
// catch its own load failure, so a database outage lands here with a retry and
// a log-searchable reference rather than printing a sheet of nothing.
export default function PrintMemberCardsError({
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
    <div className="p-8">
      <ErrorState
        message="Couldn't load the member cards. Nothing has been printed — try again."
        reference={reference}
        onRetry={reset}
      />
    </div>
  );
}
