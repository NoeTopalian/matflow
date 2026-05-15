"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { LogIn } from "lucide-react";

export function BigSignInCard() {
  const shouldReduce = useReducedMotion();

  const fadeUp: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
  };

  return (
    <section className="relative">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-60px" }}
        variants={fadeUp}
        className="max-w-3xl mx-auto px-6 -mt-8 mb-20 lg:mb-24"
      >
        <div className="relative rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-blue-700 p-1 shadow-2xl shadow-indigo-600/30">
          <div className="rounded-[calc(1.5rem-4px)] bg-gradient-to-br from-indigo-600 via-indigo-700 to-blue-800 px-6 py-8 sm:px-10 sm:py-12 text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-indigo-200 mb-3">
              Already a MatFlow gym?
            </p>
            <h2 className="text-2xl sm:text-3xl md:text-4xl font-bold text-white mb-8">
              Sign straight into your dashboard.
            </h2>

            <motion.div
              whileHover={shouldReduce ? undefined : { scale: 1.03 }}
              whileTap={shouldReduce ? undefined : { scale: 0.97 }}
              className="inline-block"
            >
              <Link
                href="/login"
                className="inline-flex items-center justify-center gap-3 px-10 py-5 sm:px-14 sm:py-6 rounded-2xl bg-white text-slate-900 text-lg sm:text-xl font-bold shadow-xl hover:bg-slate-100 transition-colors w-full sm:w-auto"
              >
                <LogIn className="w-6 h-6" aria-hidden />
                Sign in
                <span aria-hidden className="text-2xl leading-none">→</span>
              </Link>
            </motion.div>

            <p className="text-sm text-indigo-200 mt-5">
              Owners, coaches and members — one door, one login.
            </p>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
