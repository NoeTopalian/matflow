"use client";

import { motion, useReducedMotion } from "framer-motion";

const FEATURES = [
  {
    num: "01",
    title: "Belt & stripe tracking",
    body: "Per-discipline rank systems with attendance-based eligibility checks. Full promotion history, audit trail, and a queue that surfaces eligible members automatically.",
  },
  {
    num: "02",
    title: "Kiosk check-in",
    body: "iPad at the door, HMAC-tokened and isolated from the admin interface. Members tap their name; attendance and class-pack credits write atomically with no double-charge risk.",
  },
  {
    num: "03",
    title: "Branded member portal",
    body: "Your gym's name, logo and colours on every screen — schedule, announcements, personal attendance, rank progression. One branded PWA, zero app-store fees.",
  },
  {
    num: "04",
    title: "Attendance-driven promotions",
    body: "Set minimum sessions and minimum months per rank. The promotion queue runs itself. You confirm; MatFlow provides the evidence.",
  },
  {
    num: "05",
    title: "Payments that reconcile",
    body: "Stripe Connect per tenant, idempotent webhooks, refunds with auto-void of class-pack credits. Cash and comp payments recorded with audit metadata. No orphan rows.",
  },
  {
    num: "06",
    title: "Reports that actually run",
    body: "Weekly attendance trends, monthly signups, member status mix, top classes by fill rate — live from the database, not a stale CSV export from last Tuesday.",
  },
] as const;

export function FeaturesGrid() {
  const shouldReduce = useReducedMotion();

  return (
    <section className="max-w-7xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
      {/* Section header */}
      <motion.div
        initial={{ opacity: 0, y: shouldReduce ? 0 : 16 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="mb-16 lg:mb-20"
      >
        <p
          className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
          style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
        >
          What you get
        </p>
        <h2
          className="text-4xl md:text-5xl lg:text-6xl leading-tight"
          style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
        >
          Six things every BJJ academy needs.
          <span className="italic block" style={{ color: "rgba(237,232,223,0.35)" }}>
            All of them in production.
          </span>
        </h2>
      </motion.div>

      {/* Feature list */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
        {FEATURES.map(({ num, title, body }, i) => (
          <motion.div
            key={num}
            initial={{ opacity: 0, y: shouldReduce ? 0 : 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.5, delay: shouldReduce ? 0 : (i % 2) * 0.06, ease: "easeOut" }}
            className="group py-8 pr-8"
            style={{
              borderTop: "1px solid rgba(255,255,255,0.06)",
              borderRight: i % 2 === 0 ? "1px solid rgba(255,255,255,0.06)" : "none",
            }}
          >
            <div className="flex items-start gap-6">
              <span
                className="text-4xl leading-none shrink-0 mt-1 transition-colors duration-300"
                style={{
                  fontFamily: "var(--font-display)",
                  color: "rgba(61,139,255,0.25)",
                }}
              >
                {num}
              </span>
              <div>
                <h3
                  className="text-xl font-semibold mb-3 transition-colors duration-300"
                  style={{ color: "#ede8df" }}
                >
                  {title}
                </h3>
                <p className="text-sm leading-relaxed" style={{ color: "rgba(237,232,223,0.48)" }}>
                  {body}
                </p>
              </div>
            </div>
          </motion.div>
        ))}
      </div>

      <p
        className="text-xs mt-8"
        style={{ color: "rgba(237,232,223,0.25)" }}
      >
        Every feature above is live at Apex Academy, not a roadmap item.
      </p>
    </section>
  );
}
