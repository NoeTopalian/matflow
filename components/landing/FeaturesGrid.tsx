"use client";

import { motion, useReducedMotion, type Variants } from "framer-motion";
import {
  Award,
  MonitorSmartphone,
  Smartphone,
  TrendingUp,
  CreditCard,
  LineChart,
} from "lucide-react";

const FEATURES = [
  {
    icon: Award,
    title: "Belt & stripe tracking",
    body: "Per-discipline rank systems, attendance-based eligibility, full audit trail. Your digital belt book, always accurate.",
    accent: "from-indigo-500 to-blue-500",
  },
  {
    icon: MonitorSmartphone,
    title: "Kiosk check-in",
    body: "iPad at the door, HMAC-tokened, isolated from admin. Members tap their name; attendance and class-pack credits write atomically.",
    accent: "from-violet-500 to-fuchsia-500",
  },
  {
    icon: Smartphone,
    title: "Branded member portal",
    body: "Your gym's name, logo, and colours on every screen. Schedule, attendance, announcements — one branded app.",
    accent: "from-sky-500 to-cyan-500",
  },
  {
    icon: TrendingUp,
    title: "Attendance-driven promotions",
    body: "Rank requirements run automatically: minimum attendances + minimum months. Eligible members surface in the promotion queue.",
    accent: "from-emerald-500 to-teal-500",
  },
  {
    icon: CreditCard,
    title: "Payments that reconcile",
    body: "Stripe Connect per-tenant, idempotent webhooks, refunds with auto-void of class-pack credits. No double-charging, no orphan rows.",
    accent: "from-amber-500 to-orange-500",
  },
  {
    icon: LineChart,
    title: "Reports that actually run",
    body: "Weekly attendance trends, monthly signups, member status mix, top classes by fill rate — straight from the DB, not a stale CSV.",
    accent: "from-rose-500 to-pink-500",
  },
] as const;

export function FeaturesGrid() {
  const shouldReduce = useReducedMotion();

  const parent: Variants = {
    hidden: {},
    visible: { transition: { staggerChildren: shouldReduce ? 0 : 0.08 } },
  };

  const child: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 16 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
  };

  const header: Variants = {
    hidden: { opacity: 0, y: shouldReduce ? 0 : 12 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.4, ease: "easeOut" } },
  };

  return (
    <section className="max-w-6xl mx-auto px-6 py-20 lg:py-24">
      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        variants={header}
        className="max-w-2xl mx-auto mb-14 text-center"
      >
        <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.18em] text-indigo-600 mb-3">
          What you get
        </p>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-slate-900">
          Six things every BJJ academy needs.
        </h2>
        <p className="text-base md:text-lg text-slate-600 mt-4">
          Nothing experimental. Every feature below is in production at Total BJJ Nottingham.
        </p>
      </motion.div>

      <motion.div
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
        variants={parent}
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5"
      >
        {FEATURES.map(({ icon: Icon, title, body, accent }) => (
          <motion.div
            key={title}
            variants={child}
            whileHover={shouldReduce ? undefined : { y: -4 }}
            transition={{ type: "tween", duration: 0.18, ease: "easeOut" }}
            className="group relative rounded-2xl border border-slate-200 bg-white p-6 hover:border-slate-300 hover:shadow-lg hover:shadow-slate-200/60"
          >
            <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-md mb-5`}>
              <Icon className="w-5 h-5" aria-hidden />
            </div>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
            <p className="text-sm text-slate-600 leading-relaxed">{body}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}
