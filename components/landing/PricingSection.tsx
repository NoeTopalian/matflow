"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { Check } from "lucide-react";

const INCLUDED = [
  "Up to 150 members",
  "Belt and stripe tracking",
  "Kiosk check-in (iPad + QR)",
  "Branded member portal",
  "Stripe Connect billing",
  "Attendance-driven promotions",
  "Live reports + exports",
  "White-glove migration",
  "Email + chat support",
  "30-day free trial",
  "No setup fees",
  "Cancel anytime",
] as const;

export function PricingSection() {
  const shouldReduce = useReducedMotion();

  const fadeUp: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 20 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.5, ease: "easeOut" } },
  };

  return (
    <section id="pricing" className="relative bg-gradient-to-b from-slate-50 via-white to-slate-50">
      <div className="max-w-5xl mx-auto px-6 py-20 lg:py-24">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={fadeUp}
          className="text-center mb-12"
        >
          <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.18em] text-indigo-600 mb-3">
            Pricing
          </p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900">
            One plan. Everything included.
          </h2>
          <p className="text-base md:text-lg text-slate-600 mt-4 max-w-2xl mx-auto">
            No tiered upsell, no per-seat add-ons. Larger academies — get in touch.
          </p>
        </motion.div>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={fadeUp}
          className="relative rounded-3xl bg-gradient-to-br from-indigo-600 via-indigo-700 to-blue-700 p-[2px] shadow-2xl shadow-indigo-600/20"
        >
          <div className="rounded-[calc(1.5rem-2px)] bg-white p-8 md:p-12 lg:p-14 text-center">
            {/* Price */}
            <div className="flex items-baseline justify-center gap-2 mb-3">
              <span className="text-slate-500 text-lg">From</span>
              <span className="text-6xl md:text-7xl font-bold bg-gradient-to-r from-indigo-600 to-blue-600 bg-clip-text text-transparent tracking-tight">
                £89
              </span>
              <span className="text-slate-500 text-lg">/ month</span>
            </div>
            <p className="text-slate-600 mb-10">For academies up to 150 members</p>

            {/* Included list — 2-col grid, centred */}
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 max-w-2xl mx-auto mb-10 text-left">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 mt-0.5">
                    <Check className="w-3 h-3 text-indigo-700" aria-hidden />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-3 justify-center">
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
                className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl border border-slate-300 text-slate-900 text-base font-semibold hover:bg-slate-50 transition-colors"
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
