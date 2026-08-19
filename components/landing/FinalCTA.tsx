// Server component — no JS shipped for this section (speed pass B1).
// Hover states come from the .land-btn-* CSS utilities in globals.css.

import Link from "next/link";

export function FinalCTA() {
  return (
    <section
      className="relative overflow-hidden"
      style={{
        background: "#0d0c0a",
        borderTop: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      {/* Decorative diagonal gold stripe */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 70% 50% at 50% 100%, rgba(61,139,255,0.08) 0%, transparent 70%)",
        }}
      />
      {/* Top accent line */}
      <div
        aria-hidden
        className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-64"
        style={{ background: "linear-gradient(90deg, transparent, rgba(61,139,255,0.5), transparent)" }}
      />

      <div className="max-w-4xl mx-auto px-6 lg:px-10 py-28 lg:py-36 text-center">
        <p
          className="text-xs font-semibold uppercase tracking-[0.18em] mb-6"
          style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
        >
          Ready?
        </p>
        <h2
          className="text-4xl sm:text-5xl lg:text-7xl leading-[1.04] mb-8"
          style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
        >
          Run your academy like
          <br />
          <span className="italic" style={{ color: "#3d8bff" }}>
            the one they deserve.
          </span>
        </h2>
        <p className="text-lg mb-10 max-w-xl mx-auto" style={{ color: "rgba(237,232,223,0.48)" }}>
          Apply now. We respond within one business day with your gym code and a brief call to confirm
          MatFlow is the right fit.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/apply"
            className="land-btn-primary inline-flex items-center gap-2 px-9 py-4 rounded-xl text-base font-semibold"
          >
            Apply for an account →
          </Link>
          <Link
            href="/login"
            className="land-btn-ghost inline-flex items-center gap-2 px-9 py-4 rounded-xl text-base font-semibold"
          >
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}
