"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

const STEPS = [
  {
    n: "01",
    title: "Apply",
    body: "Fill in the form at /apply — your gym name, owner contact, discipline, and member count. No credit card required.",
  },
  {
    n: "02",
    title: "Review",
    body: "We respond within 1 business day with your gym code and login details. Honest feedback if MatFlow isn't the right fit.",
  },
  {
    n: "03",
    title: "Go live",
    body: "White-glove migration from your current platform — members, ranks, attendance history, subscriptions. Your 30-day free trial starts on go-live day.",
  },
] as const;

export function ApplySection() {
  const shouldReduce = useReducedMotion();

  return (
    <section
      id="apply"
      style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
        <motion.div
          initial={{ opacity: 0, y: shouldReduce ? 0 : 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="mb-16"
        >
          <p
            className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
            style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
          >
            How to get started
          </p>
          <h2
            className="text-4xl md:text-5xl lg:text-6xl max-w-2xl"
            style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
          >
            Application to live{" "}
            <span className="italic" style={{ color: "rgba(237,232,223,0.35)" }}>
              in three steps.
            </span>
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px mb-16"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          {STEPS.map(({ n, title, body }, i) => (
            <motion.div
              key={n}
              initial={{ opacity: 0, y: shouldReduce ? 0 : 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.5, delay: shouldReduce ? 0 : i * 0.1, ease: "easeOut" }}
              className="p-8 lg:p-10"
              style={{ background: "#0a0908" }}
            >
              <span
                className="block text-5xl mb-6"
                style={{ fontFamily: "var(--font-display)", color: "rgba(61,139,255,0.2)" }}
              >
                {n}
              </span>
              <h3
                className="text-xl font-semibold mb-4"
                style={{ color: "#ede8df" }}
              >
                {title}
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(237,232,223,0.48)" }}>
                {body}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: shouldReduce ? 0 : 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-60px" }}
          transition={{ duration: 0.5, ease: "easeOut" }}
          className="flex flex-wrap gap-3"
        >
          <motion.div
            whileHover={shouldReduce ? undefined : { scale: 1.03 }}
            whileTap={shouldReduce ? undefined : { scale: 0.97 }}
          >
            <Link
              href="/apply"
              className="inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold transition-all duration-200"
              style={{ background: "#3d8bff", color: "#0a0908" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#5da0ff"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#3d8bff"; }}
            >
              Apply now →
            </Link>
          </motion.div>
          <a
            href="mailto:hello@matflow.io"
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
            Email us first
          </a>
        </motion.div>
      </div>
    </section>
  );
}
