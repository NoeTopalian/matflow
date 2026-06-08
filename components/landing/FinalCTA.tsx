"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

export function FinalCTA() {
  const shouldReduce = useReducedMotion();

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

      <motion.div
        initial={{ opacity: 0, y: shouldReduce ? 0 : 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="max-w-4xl mx-auto px-6 lg:px-10 py-28 lg:py-36 text-center"
      >
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
          <motion.div
            whileHover={shouldReduce ? undefined : { scale: 1.04 }}
            whileTap={shouldReduce ? undefined : { scale: 0.97 }}
          >
            <Link
              href="/apply"
              className="inline-flex items-center gap-2 px-9 py-4.5 rounded-xl text-base font-semibold transition-all duration-200"
              style={{ background: "#3d8bff", color: "#0a0908", padding: "1rem 2.25rem" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#5da0ff"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#3d8bff"; }}
            >
              Apply for an account →
            </Link>
          </motion.div>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 rounded-xl text-base font-semibold transition-all duration-200"
            style={{
              color: "rgba(237,232,223,0.5)",
              border: "1px solid rgba(255,255,255,0.09)",
              padding: "1rem 2.25rem",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = "#ede8df";
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.18)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.color = "rgba(237,232,223,0.5)";
              (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.09)";
            }}
          >
            Sign in
          </Link>
        </div>
      </motion.div>
    </section>
  );
}
