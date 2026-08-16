"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@/components/ui/ErrorState";

// Route-segment error boundary for the member portal (UI-RULES §7). The
// member shell is dark; ErrorState is token-driven so it renders correctly
// here without polarity hacks.
export default function MemberError({
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
    <div className="px-4 py-12">
      <ErrorState
        message="Something went wrong. Your account is fine — try again."
        onRetry={reset}
      />
    </div>
  );
}
