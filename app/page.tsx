// Public marketing landing page at matflow.studio.
//
// Replaces the previous `redirect("/dashboard")` so cold-email outreach has
// somewhere to point. Authenticated users still navigate to /dashboard or
// /member from the top-nav links; this page renders for everyone.
//
// Proxy.ts must treat `/` as public — see lib/proxy logic.

import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "MatFlow — Gym software built for BJJ academies",
  description:
    "Member management, kiosk check-in, rank & belt tracking, and a branded portal. Built specifically for Brazilian Jiu-Jitsu gyms in the UK.",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* Top nav */}
      <nav className="border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-slate-900 text-white flex items-center justify-center font-bold text-sm">
              M
            </div>
            <span className="font-bold text-lg">MatFlow</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm font-medium text-slate-700 hover:text-slate-900"
            >
              Sign in
            </Link>
            <Link
              href="/apply"
              className="text-sm font-medium px-4 py-2 rounded-lg bg-slate-900 text-white hover:bg-slate-800"
            >
              Apply for an account
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 py-20 lg:py-28">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">
            For UK Brazilian Jiu-Jitsu academies
          </p>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-tight mb-6">
            Gym software that
            <br />
            actually speaks BJJ.
          </h1>
          <p className="text-lg md:text-xl text-slate-600 leading-relaxed mb-8 max-w-2xl">
            Belt and stripe tracking, attendance-driven promotions, kiosk
            check-in, and a branded member portal. Built specifically for the
            way BJJ academies run — not bolted on to generic fitness software.
          </p>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/apply"
              className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors"
            >
              Request a demo
            </Link>
            <Link
              href="/login"
              className="inline-flex items-center justify-center px-6 py-3 rounded-lg border border-slate-300 text-slate-900 font-semibold hover:bg-slate-50 transition-colors"
            >
              I have an account
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <FeatureCard
            title="Belt & stripe tracking"
            body="Per-discipline rank systems, attendance-based eligibility, full promotion history with audit trail. Your digital belt book, always accurate."
          />
          <FeatureCard
            title="Kiosk check-in"
            body="iPad at the door, HMAC-tokened, isolated from your admin account. Members tap their name, system records attendance and redeems class-pack credits atomically."
          />
          <FeatureCard
            title="Branded member portal"
            body="Your gym's name, logo, colours and font on every member screen. Class schedule, attendance history, announcements — all in one app."
          />
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-10 md:p-14 text-center">
          <p className="text-sm font-semibold uppercase tracking-wider text-slate-500 mb-4">
            Pricing
          </p>
          <h2 className="text-3xl md:text-4xl font-bold tracking-tight mb-4">
            One plan. Everything included.
          </h2>
          <p className="text-lg text-slate-600 mb-8 max-w-2xl mx-auto">
            From <span className="font-bold text-slate-900">£89/month</span>{" "}
            for academies up to 150 members. White-glove migration from your
            current software. 30-day free trial. No setup fees.
          </p>
          <Link
            href="/apply"
            className="inline-flex items-center justify-center px-6 py-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 transition-colors"
          >
            Apply for an account
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-200 mt-12">
        <div className="max-w-6xl mx-auto px-6 py-10 flex flex-wrap items-center justify-between gap-4 text-sm text-slate-500">
          <div>© 2026 MatFlow</div>
          <div className="flex gap-6">
            <Link href="/legal/terms" className="hover:text-slate-900">
              Terms
            </Link>
            <Link href="/legal/privacy" className="hover:text-slate-900">
              Privacy
            </Link>
            <a
              href="mailto:hello@matflow.io"
              className="hover:text-slate-900"
            >
              Contact
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6">
      <h3 className="text-lg font-bold mb-3">{title}</h3>
      <p className="text-slate-600 leading-relaxed">{body}</p>
    </div>
  );
}
