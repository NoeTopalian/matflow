"use client";

import { useEffect, useMemo } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";
import { errorReferenceFromDigest } from "@/lib/error-reference";

/**
 * The one implementation behind every route-segment `error.tsx` (UI-RULES §7).
 *
 * Two boundaries existed — dashboard and member — and were identical apart from
 * their wording and padding. Nine more segments had none at all, so a throw on
 * the kiosk tablet mid-class, on the login page, or in the middle of signing a
 * waiver showed Next's unbranded "Application error", with no reference to
 * quote and no way back except reloading. Copying the logic nine more times is
 * how three belt graphics ended up disagreeing with each other; this is the
 * same mistake, avoided.
 *
 * `error.digest` is the only thing Next ships to the browser about a server
 * error. Hashing it here produces exactly the reference `instrumentation.ts`'s
 * onRequestError already wrote into the server log beside the real stack, so
 * what a person reads out over the phone is searchable. A purely client-side
 * render error has no digest, so it gets no reference — there is no server log
 * line to point at, and inventing an id would be a lie dressed as diagnostics.
 *
 * `ErrorState` is token-driven, so this renders correctly on the light staff
 * shell and the dark tenant-branded member and kiosk shells without any
 * polarity handling here.
 */
export function SegmentErrorBoundary({
  error,
  reset,
  message,
  className = "py-12",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  message: string;
  className?: string;
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
    <div className={className}>
      <ErrorState message={message} reference={reference} onRetry={reset} />
    </div>
  );
}

export default SegmentErrorBoundary;
