"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";

export function Hero() {
  const shouldReduce = useReducedMotion();

  const parent: Variants = {
    hidden: {},
    visible: {
      transition: { staggerChildren: shouldReduce ? 0 : 0.08, delayChildren: 0.05 },
    },
  };

  const item: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 16 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
  };

  return (
    <section className="relative overflow-hidden">
      {/* Layered backdrops — radial indigo wash + dotted grid for texture */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_60%_at_50%_0%,rgba(79,70,229,0.12),transparent_70%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 opacity-[0.05] [background-image:radial-gradient(rgb(15,23,42)_1px,transparent_1px)] [background-size:18px_18px]"
      />

      <motion.div
        variants={parent}
        initial="hidden"
        animate="visible"
        className="max-w-4xl mx-auto px-6 pt-20 pb-24 lg:pt-28 lg:pb-32 text-center"
      >
        <motion.div variants={item} className="inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-1.5 text-xs sm:text-sm font-semibold text-indigo-700 mb-6">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-500" />
          </span>
          For UK Brazilian Jiu-Jitsu academies
        </motion.div>

        <motion.h1
          variants={item}
          className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.05] text-slate-900 mb-6"
        >
          Gym software that{" "}
          <span className="bg-gradient-to-r from-indigo-600 via-indigo-500 to-blue-500 bg-clip-text text-transparent">
            actually speaks BJJ.
          </span>
        </motion.h1>

        <motion.p
          variants={item}
          className="text-lg md:text-xl text-slate-600 leading-relaxed mb-10 max-w-2xl mx-auto"
        >
          Belt and stripe tracking, attendance-driven promotions, kiosk check-in, and a branded
          member portal. Built specifically for the way BJJ academies run — not bolted onto generic
          fitness software.
        </motion.p>

        <motion.div variants={item} className="flex flex-wrap gap-3 items-center justify-center">
          <motion.div whileHover={shouldReduce ? undefined : { scale: 1.02 }} whileTap={shouldReduce ? undefined : { scale: 0.98 }}>
            <Link
              href="/apply"
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-to-b from-indigo-600 to-indigo-700 text-white text-base font-semibold shadow-lg shadow-indigo-600/25 hover:shadow-xl hover:shadow-indigo-600/30 transition-shadow"
            >
              Apply for an account
              <span aria-hidden>→</span>
            </Link>
          </motion.div>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl border border-slate-300 bg-white text-slate-900 text-base font-semibold hover:bg-slate-50 transition-colors"
          >
            I have an account
          </Link>
        </motion.div>

        <motion.p variants={item} className="text-sm text-slate-500 mt-6">
          No credit card needed to apply · 1 business-day review
        </motion.p>
      </motion.div>
    </section>
  );
}
