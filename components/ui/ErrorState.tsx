"use client";

/**
 * ErrorState — the ONLY way to render a failed load (UI-RULES §7).
 * An HTTP error must never be shown as an empty state: use this, with retry.
 * Token-driven: renders correctly on both the light staff shell and the
 * dark member shell (no hardcoded polarity — UI-RULES §1).
 */
export function ErrorState({
  message = "Couldn't load — tap to retry",
  onRetry,
  className = "",
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={`flex flex-col items-center justify-center gap-3 rounded-[var(--r-md)] border px-6 py-8 text-center ${className}`}
      style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
    >
      <p className="text-sm">{message}</p>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-[var(--r-sm)] border px-4 text-sm font-medium transition-colors"
          style={{ borderColor: "var(--bd-active)", color: "var(--tx-1)" }}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}

export default ErrorState;
