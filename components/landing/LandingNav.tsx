"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

export function LandingNav() {
  const shouldReduce = useReducedMotion();
  return (
    <motion.nav
      initial={{ opacity: 0, y: shouldReduce ? 0 : -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="sticky top-0 z-40 border-b border-slate-200 bg-white/80 backdrop-blur"
    >
      <div className="max-w-6xl mx-auto px-6 py-3 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm">
            M
          </div>
          <span className="font-bold text-lg text-slate-900">MatFlow</span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <Link
            href="/apply"
            className="hidden sm:inline-flex items-center text-sm font-medium text-slate-700 hover:text-slate-900 px-3 py-2"
          >
            Apply
          </Link>
          <motion.div whileHover={shouldReduce ? undefined : { scale: 1.03 }} whileTap={shouldReduce ? undefined : { scale: 0.97 }}>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-b from-indigo-600 to-indigo-700 text-white text-sm font-semibold shadow-md shadow-indigo-600/20 hover:shadow-lg hover:shadow-indigo-600/30 transition-shadow"
            >
              Sign in
              <span aria-hidden className="text-base leading-none">→</span>
            </Link>
          </motion.div>
        </div>
      </div>
    </motion.nav>
  );
}
