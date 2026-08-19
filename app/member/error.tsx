"use client";

import { useEffect, useMemo } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";
import { errorReferenceFromDigest } from "@/lib/error-reference";

// Route-segment error boundary for the member portal (UI-RULES §7). The
// member shell is dark; ErrorState is token-driven so it renders correctly
// here without polarity hacks.
//
// The reference is derived from Next's `error.digest`, which is the same
// value `instrumentation.ts` hashed when it logged the failure server-side —
// so a member reading this id out gives their gym owner a direct search key
// into the log. No digest (a purely client-side render error) means no server
// log line exists, so no reference is shown.
export default function MemberError({
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
    <div className="px-4 py-12">
      <ErrorState
        message="Something went wrong. Your account is fine — try again."
        reference={reference}
        onRetry={reset}
      />
    </div>
  );
}
