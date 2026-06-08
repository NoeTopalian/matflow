"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";

const BELT_COLORS: Record<string, string> = {
  white: "#d4d4d4",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  brown: "#92400e",
  black: "#1c1c1e",
};

const MOCK_MEMBERS = [
  { name: "Alex Reed", belt: "blue" as const, stripes: 3, classes: 89, required: 90, eligible: true },
  { name: "Jordan Mills", belt: "purple" as const, stripes: 1, classes: 52, required: 120, eligible: false },
  { name: "Casey Park", belt: "white" as const, stripes: 0, classes: 18, required: 50, eligible: false },
  { name: "Sam Torres", belt: "brown" as const, stripes: 4, classes: 158, required: 150, eligible: true },
];

function BeltTrackerMockup() {
  return (
    <div
      className="rounded-2xl overflow-hidden w-full"
      style={{
        background: "#111009",
        border: "1px solid rgba(255,255,255,0.08)",
        boxShadow: "0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(61,139,255,0.08)",
        maxWidth: 380,
      }}
    >
      {/* Window chrome */}
      <div
        className="flex items-center gap-2 px-4 py-3"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}
      >
        <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#ef4444" }} />
        <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#f59e0b" }} />
        <div className="w-2.5 h-2.5 rounded-full" style={{ background: "#22c55e" }} />
        <span
          className="ml-auto text-[10px] font-semibold tracking-widest"
          style={{ color: "rgba(237,232,223,0.25)", fontFamily: "var(--font-label)" }}
        >
          MATFLOW
        </span>
      </div>

      {/* Header */}
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
        <p
          className="text-[10px] font-semibold uppercase tracking-widest mb-1"
          style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
        >
          Belt Tracker
        </p>
        <p className="text-xs" style={{ color: "rgba(237,232,223,0.38)" }}>
          Apex Academy · 47 active members
        </p>
      </div>

      {/* Member rows */}
      <div>
        {MOCK_MEMBERS.map((m, i) => {
          const pct = Math.min((m.classes / m.required) * 100, 100);
          return (
            <div
              key={m.name}
              className="px-5 py-3.5"
              style={{
                borderBottom: i < MOCK_MEMBERS.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
              }}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <p className="text-xs font-semibold mb-1.5" style={{ color: "#ede8df" }}>
                    {m.name}
                  </p>
                  <div className="flex items-center gap-2">
                    <div
                      className="h-1.5 rounded-sm"
                      style={{ width: 22, background: BELT_COLORS[m.belt] }}
                    />
                    <div className="flex gap-1">
                      {[0, 1, 2, 3].map((si) => (
                        <div
                          key={si}
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            background: si < m.stripes ? "#e8b86d" : "rgba(255,255,255,0.12)",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
                {m.eligible && (
                  <span
                    className="text-[9px] font-semibold tracking-wider px-2 py-1 rounded-full whitespace-nowrap"
                    style={{
                      background: "rgba(61,139,255,0.15)",
                      color: "#e8b86d",
                      fontFamily: "var(--font-label)",
                    }}
                  >
                    ELIGIBLE
                  </span>
                )}
              </div>
              <div className="h-0.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${pct}%`,
                    background: m.eligible ? "#3d8bff" : "rgba(61,139,255,0.35)",
                  }}
                />
              </div>
              <p className="text-[9px] mt-1" style={{ color: "rgba(237,232,223,0.25)" }}>
                {m.classes}/{m.required} sessions attended
              </p>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div
        className="px-5 py-3.5 flex items-center justify-between"
        style={{ background: "rgba(61,139,255,0.06)", borderTop: "1px solid rgba(61,139,255,0.1)" }}
      >
        <p className="text-xs font-semibold" style={{ color: "#e8b86d" }}>
          2 eligible for promotion
        </p>
        <span className="text-xs" style={{ color: "#3d8bff" }}>
          View queue →
        </span>
      </div>
    </div>
  );
}

export function Hero() {
  const shouldReduce = useReducedMotion();

  const stagger: Variants = {
    hidden: {},
    visible: { transition: { staggerChildren: shouldReduce ? 0 : 0.09, delayChildren: 0.1 } },
  };

  const slide: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] } },
  };

  return (
    <section className="relative overflow-hidden" style={{ minHeight: "calc(100svh - 4rem)" }}>
      {/* Background radial glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 20% -10%, rgba(61,139,255,0.07) 0%, transparent 60%), radial-gradient(ellipse 60% 40% at 80% 110%, rgba(61,139,255,0.04) 0%, transparent 55%)",
        }}
      />
      {/* Dot grid */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          opacity: 0.035,
          backgroundImage: "radial-gradient(rgba(237,232,223,1) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-16 pb-20 lg:pt-24 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-8 items-center">
          {/* Left: copy */}
          <motion.div
            className="lg:col-span-7"
            variants={stagger}
            initial="hidden"
            animate="visible"
          >
            <motion.div variants={slide} className="mb-6">
              <span
                className="inline-flex items-center gap-2 text-xs font-semibold tracking-[0.18em] uppercase px-3 py-1.5 rounded-full"
                style={{
                  color: "#3d8bff",
                  background: "rgba(61,139,255,0.1)",
                  border: "1px solid rgba(61,139,255,0.2)",
                  fontFamily: "var(--font-label)",
                }}
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span
                    className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
                    style={{ background: "#3d8bff" }}
                  />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: "#3d8bff" }} />
                </span>
                BJJ-native gym software
              </span>
            </motion.div>

            <motion.h1 variants={slide} className="mb-6 leading-[1.04]">
              <span
                className="block text-5xl sm:text-6xl lg:text-[5.5rem]"
                style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
              >
                The gym software
              </span>
              <span
                className="block text-5xl sm:text-6xl lg:text-[5.5rem] italic"
                style={{ fontFamily: "var(--font-display)", color: "#3d8bff" }}
              >
                built for the mat.
              </span>
            </motion.h1>

            <motion.p
              variants={slide}
              className="text-lg leading-relaxed mb-10 max-w-xl"
              style={{ color: "rgba(237,232,223,0.58)" }}
            >
              Belt and stripe tracking, attendance-driven promotions, kiosk check-in, and a branded
              member portal — built for the way BJJ academies actually run, not bolted onto generic
              fitness software.
            </motion.p>

            <motion.div variants={slide} className="flex flex-wrap gap-3 items-center mb-6">
              <motion.div
                whileHover={shouldReduce ? undefined : { scale: 1.03 }}
                whileTap={shouldReduce ? undefined : { scale: 0.97 }}
              >
                <Link
                  href="/apply"
                  className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl text-base font-semibold transition-all duration-200"
                  style={{ background: "#3d8bff", color: "#0a0908" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#5da0ff"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#3d8bff"; }}
                >
                  Apply for an account
                  <span aria-hidden>→</span>
                </Link>
              </motion.div>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl text-base font-semibold transition-all duration-200"
                style={{
                  color: "rgba(237,232,223,0.75)",
                  border: "1px solid rgba(255,255,255,0.1)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.2)";
                  (e.currentTarget as HTMLAnchorElement).style.color = "#ede8df";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLAnchorElement).style.borderColor = "rgba(255,255,255,0.1)";
                  (e.currentTarget as HTMLAnchorElement).style.color = "rgba(237,232,223,0.75)";
                }}
              >
                I have an account
              </Link>
            </motion.div>

            <motion.p variants={slide} className="text-sm" style={{ color: "rgba(237,232,223,0.3)" }}>
              30-day free trial · No credit card needed · UK BJJ academies only
            </motion.p>
          </motion.div>

          {/* Right: UI mockup */}
          <motion.div
            className="lg:col-span-5 flex justify-center lg:justify-end"
            initial={{ opacity: 0, y: shouldReduce ? 0 : 32, rotate: shouldReduce ? 0 : 1 }}
            animate={{ opacity: 1, y: 0, rotate: 0 }}
            transition={{ duration: 0.8, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <BeltTrackerMockup />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
