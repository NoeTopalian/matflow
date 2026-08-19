"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/Toast";
import { formatDateTime } from "@/lib/date";

/**
 * ErrorState — the ONLY way to render a failed load (UI-RULES §7).
 * An HTTP error must never be shown as an empty state: use this, with retry.
 * Token-driven: renders correctly on both the light staff shell and the
 * dark member shell (no hardcoded polarity — UI-RULES §1).
 *
 * Pass `reference` (the `reference` field of an API error body, or the value
 * derived from `error.digest` in a route-segment `error.tsx`) and the failure
 * becomes diagnosable: the same id is sitting in the server log next to the
 * real stack. Nothing internal is ever shown — the reference is the whole of
 * what the user is given.
 */
export function ErrorState({
  message = "Couldn't load — tap to retry",
  reference,
  onRetry,
  className = "",
}: {
  message?: string;
  /** Short error reference, e.g. "MF-4K7P3R". Hidden when absent. */
  reference?: string | null;
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
      {reference ? <ErrorReference reference={reference} /> : null}
    </div>
  );
}

/**
 * The quotable half of an error report. Shows the reference and copies a
 * short, plain-English note — reference, page and time — that an owner can
 * paste into an email or a message without editing it.
 */
export function ErrorReference({ reference }: { reference: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  async function copy() {
    const lines = [
      `MatFlow error reference ${reference}`,
      typeof window !== "undefined" ? `Page: ${window.location.pathname}` : null,
      `Time: ${formatDateTime(new Date())}`,
    ].filter(Boolean);

    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast("Reference copied — paste it into your message.", "success");
    } catch {
      // Clipboard blocked (insecure context, permission denied). Put the
      // reference in the toast so it can still be written down.
      toast(`Couldn't copy automatically — the reference is ${reference}`, "warning", 8000);
    }
  }

  return (
    <div className="flex flex-col items-center gap-1.5 pt-1">
      <div className="flex items-center gap-2">
        <span className="text-xs" style={{ color: "var(--tx-3)" }}>
          Reference
        </span>
        <code
          className="rounded-[var(--r-sm)] border px-2 py-0.5 font-mono text-xs tracking-wider"
          style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
        >
          {reference}
        </code>
        <Button
          variant="ghost"
          size="compact"
          onClick={copy}
          aria-label={`Copy error reference ${reference}`}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs" style={{ color: "var(--tx-4)" }}>
        Quote this if you report the problem — it points us at the exact failure.
      </p>
    </div>
  );
}

export default ErrorState;
