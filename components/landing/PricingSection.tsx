"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const INCLUDED = [
  "Up to 150 members",
  "Belt and stripe tracking",
  "Kiosk check-in (iPad + QR)",
  "Branded member portal (PWA)",
  "Stripe Connect billing",
  "Attendance-driven promotions",
  "Live reports & exports",
  "White-glove data migration",
  "Email and chat support",
  "30-day free trial",
  "No setup fees",
  "Cancel anytime",
] as const;

export function PricingSection() {
  const shouldReduce = useReducedMotion();

  return (
    <section
      id="pricing"
      style={{
        background: "#0d0c0a",
        borderTop: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="max-w-5xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
        <motion.div
          initial={{ opacity: 0, y: shouldReduce ? 0 : 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="text-center mb-14"
        >
          <p
            className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
            style={{ color: "#c4923f", fontFamily: "var(--font-label)" }}
          >
            Pricing
          </p>
          <h2
            className="text-4xl md:text-5xl lg:text-6xl mb-4"
            style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
          >
            One plan.{" "}
            <span className="italic" style={{ color: "rgba(237,232,223,0.35)" }}>
              Everything included.
            </span>
          </h2>
          <p className="text-base" style={{ color: "rgba(237,232,223,0.48)" }}>
            No tiered upsell, no per-seat add-ons. Larger academies — get in touch.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: shouldReduce ? 0 : 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="rounded-2xl overflow-hidden"
          style={{
            background: "#141210",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "0 0 0 1px rgba(196,146,63,0.08), 0 40px 80px rgba(0,0,0,0.4)",
          }}
        >
          {/* Gold top accent bar */}
          <div className="h-0.5 w-full" style={{ background: "linear-gradient(90deg, transparent, #c4923f, transparent)" }} />

          <div className="px-8 md:px-14 py-12 md:py-16">
            {/* Price */}
            <div className="text-center mb-12">
              <div className="flex items-baseline justify-center gap-2 mb-2">
                <span className="text-lg" style={{ color: "rgba(237,232,223,0.4)" }}>From</span>
                <span
                  className="text-7xl md:text-8xl font-bold leading-none"
                  style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
                >
                  £89
                </span>
                <span className="text-lg" style={{ color: "rgba(237,232,223,0.4)" }}>/ month</span>
              </div>
              <p className="text-sm" style={{ color: "rgba(237,232,223,0.35)" }}>
                For academies up to 150 members
              </p>
            </div>

            {/* Divider */}
            <div className="h-px mb-12" style={{ background: "rgba(255,255,255,0.06)" }} />

            {/* Included list */}
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3.5 mb-12 max-w-2xl mx-auto">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm" style={{ color: "rgba(237,232,223,0.65)" }}>
                  <span
                    className="shrink-0 text-base leading-none"
                    style={{ color: "#c4923f" }}
                    aria-hidden
                  >
                    ✦
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            {/* CTAs */}
            <div className="flex flex-wrap gap-3 justify-center">
              <motion.div
                whileHover={shouldReduce ? undefined : { scale: 1.03 }}
                whileTap={shouldReduce ? undefined : { scale: 0.97 }}
              >
                <Link
                  href="/apply"
                  className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold transition-all duration-200"
                  style={{ background: "#c4923f", color: "#0a0908" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#d4a34f"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#c4923f"; }}
                >
                  Apply for an account →
                </Link>
              </motion.div>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold transition-all duration-200"
                style={{
                  color: "rgba(237,232,223,0.6)",
                  border: "1px solid rgba(255,255,255,0.09)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = "#ede8df";
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.18)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.color = "rgba(237,232,223,0.6)";
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.09)";
                }}
              >
                Sign in
              </Link>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
