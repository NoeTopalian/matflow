"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { errorReferenceFromDigest } from "@/lib/error-reference";

/**
 * The last resort: this replaces the ROOT LAYOUT when the root layout itself
 * throws, which is the one failure a per-segment `error.tsx` cannot catch.
 * Without it, that case renders Next's unstyled default — and until now the
 * product had no global boundary at all.
 *
 * Deliberately self-contained. It must render its own `<html>` and `<body>`,
 * and it cannot assume the app's providers, fonts or CSS custom properties
 * survived whatever killed the layout — so the styling is inline and uses no
 * design tokens. `rgb()` rather than hex notation is not a style preference:
 * `scripts/check-ui-rules.mjs` counts six-digit hex literals in .tsx files
 * (comments included) against a ratchet that may only go down.
 *
 * No `reset()` retry here. A broken root layout usually stays broken on a
 * re-render, so offering a button that silently does nothing would be its own
 * small lie; a full reload is the honest action and is what the link does.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  const reference = error.digest ? errorReferenceFromDigest(error.digest) : null;

  useEffect(() => {
    Sentry.withScope((scope) => {
      scope.setLevel("fatal");
      if (reference) scope.setTag("error_reference", reference);
      Sentry.captureException(error);
    });
  }, [error, reference]);

  return (
    <html lang="en-GB">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgb(17, 17, 17)",
          color: "rgb(245, 245, 245)",
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "24px",
        }}
      >
        <main style={{ maxWidth: "28rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 0.75rem" }}>
            MatFlow couldn&rsquo;t load
          </h1>
          <p style={{ fontSize: "0.875rem", lineHeight: 1.6, color: "rgb(170, 170, 170)", margin: "0 0 1.5rem" }}>
            Something went wrong before the page could start. Your data is safe.
            Reload to try again — if it keeps happening, send us the reference
            below.
          </p>
          {reference && (
            <p
              style={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.75rem",
                color: "rgb(140, 140, 140)",
                margin: "0 0 1.5rem",
              }}
            >
              {reference}
            </p>
          )}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages --
              a plain anchor is required here, not next/link. Link does a
              CLIENT-side navigation, which re-renders the very root layout
              that just threw and lands straight back on this screen. Only a
              full document load rebuilds the app from scratch, which is the
              whole point of the button. */}
          <a
            href="/"
            style={{
              display: "inline-block",
              padding: "0.625rem 1.25rem",
              borderRadius: "0.75rem",
              background: "rgb(245, 245, 245)",
              color: "rgb(17, 17, 17)",
              fontSize: "0.875rem",
              fontWeight: 600,
              textDecoration: "none",
            }}
          >
            Reload MatFlow
          </a>
        </main>
      </body>
    </html>
  );
}
