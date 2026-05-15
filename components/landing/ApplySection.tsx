"use client";

import Link from "next/link";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { FileText, Phone, Rocket } from "lucide-react";

const STEPS = [
  {
    icon: FileText,
    title: "Apply",
    body: "Tell us about your academy — name, owner contact, discipline, member count. Real form at /apply, no credit card required.",
    accent: "from-indigo-500 to-blue-500",
  },
  {
    icon: Phone,
    title: "Review",
    body: "We're back within 1 business day with your gym code and login details. Honest feedback if MatFlow isn't the right fit.",
    accent: "from-violet-500 to-fuchsia-500",
  },
  {
    icon: Rocket,
    title: "Onboard",
    body: "White-glove migration from your current platform — members, attendance, ranks, active subscriptions. 30-day free trial begins on go-live.",
    accent: "from-emerald-500 to-teal-500",
  },
] as const;

export function ApplySection() {
  const shouldReduce = useReducedMotion();

  const parent: Variants = {
    hidden: {},
    visible: { transition: { staggerChildren: shouldReduce ? 0 : 0.12 } },
  };

  const child: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 16 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: "easeOut" } },
  };

  const header: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 12 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
  };

  return (
    <section id="apply" className="border-t border-slate-200 bg-gradient-to-b from-white via-indigo-50/30 to-white">
      <div className="max-w-6xl mx-auto px-6 py-20 lg:py-24">
        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={header}
          className="max-w-2xl mx-auto mb-14 text-center"
        >
          <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.18em] text-indigo-600 mb-3">
            How to get started
          </p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900">
            From application to live in three steps.
          </h2>
          <p className="text-base md:text-lg text-slate-600 mt-4">
            No long demos, no boilerplate sales call. We treat your time the way we'd want ours
            treated.
          </p>
        </motion.div>

        <motion.ol
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={parent}
          className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-14"
        >
          {STEPS.map(({ icon: Icon, title, body, accent }, idx) => (
            <motion.li
              key={title}
              variants={child}
              className="relative rounded-2xl border border-slate-200 bg-white p-7 text-center"
            >
              <div className={`mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-lg mb-5`}>
                <Icon className="w-6 h-6" aria-hidden />
              </div>
              <div className="inline-flex items-center gap-2 mb-3">
                <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-900 text-white text-xs font-semibold">
                  {idx + 1}
                </span>
                <h3 className="text-lg font-semibold text-slate-900">{title}</h3>
              </div>
              <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
            </motion.li>
          ))}
        </motion.ol>

        <motion.div
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={header}
          className="flex flex-wrap gap-3 justify-center"
        >
          <motion.div whileHover={shouldReduce ? undefined : { scale: 1.02 }} whileTap={shouldReduce ? undefined : { scale: 0.98 }}>
            <Link
              href="/apply"
              className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl bg-gradient-to-b from-indigo-600 to-indigo-700 text-white text-base font-semibold shadow-lg shadow-indigo-600/25 hover:shadow-xl hover:shadow-indigo-600/30 transition-shadow"
            >
              Apply now
              <span aria-hidden>→</span>
            </Link>
          </motion.div>
          <a
            href="mailto:hello@matflow.io"
            className="inline-flex items-center gap-2 px-7 py-3.5 rounded-xl border border-slate-300 bg-white text-slate-900 text-base font-semibold hover:bg-slate-50 transition-colors"
          >
            Email us first
          </a>
        </motion.div>
      </div>
    </section>
  );
}
