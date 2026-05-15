"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";

export function FinalCTA() {
  const shouldReduce = useReducedMotion();

  const fadeUp: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
  };

  return (
    <section className="relative bg-gradient-to-br from-slate-900 via-indigo-900 to-slate-900 text-white overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30 [background-image:radial-gradient(circle_at_30%_20%,rgba(99,102,241,0.4),transparent_50%),radial-gradient(circle_at_70%_80%,rgba(59,130,246,0.3),transparent_50%)]" />
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        variants={fadeUp}
        className="max-w-4xl mx-auto px-6 py-20 lg:py-24 text-center"
      >
        <h2 className="text-3xl md:text-5xl font-bold tracking-tight mb-5">
          Run your academy like the one your members deserve.
        </h2>
        <p className="text-lg text-slate-300 mb-9 max-w-2xl mx-auto">
          Apply now. We'll be in touch within one business day with your gym code and a short call
          to make sure MatFlow fits.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <motion.div whileHover={shouldReduce ? undefined : { scale: 1.03 }} whileTap={shouldReduce ? undefined : { scale: 0.97 }}>
            <Link
              href="/apply"
              className="inline-flex items-center gap-2 px-7 py-4 rounded-xl bg-white text-slate-900 text-base font-semibold shadow-sm hover:bg-slate-100 transition-colors"
            >
              Apply for an account
              <span aria-hidden>→</span>
            </Link>
          </motion.div>
          <Link
            href="/login"
            className="inline-flex items-center gap-2 px-7 py-4 rounded-xl border border-white/30 text-white text-base font-semibold hover:bg-white/10 transition-colors"
          >
            Sign in
          </Link>
        </div>
      </motion.div>
    </section>
  );
}
