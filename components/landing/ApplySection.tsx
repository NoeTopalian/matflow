// Server component — the actual application form lives at /apply; this
// section is pure content, so it ships no JS (speed pass B1). Hover states
// come from the land-* classes in globals.css.

import Link from "next/link";

const STEPS = [
  {
    n: "01",
    title: "Apply",
    body: "Fill in the form at /apply — your gym name, owner contact, discipline, and member count. No credit card required.",
  },
  {
    n: "02",
    title: "Review",
    body: "We respond within 1 business day with your gym code and login details. Honest feedback if MatFlow isn't the right fit.",
  },
  {
    n: "03",
    title: "Go live",
    body: "White-glove migration from your current platform — members, ranks, attendance history, subscriptions. Your 30-day free trial starts on go-live day.",
  },
] as const;

export function ApplySection() {
  return (
    <section
      id="apply"
      style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
        <div className="mb-16">
          <p
            className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
            style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
          >
            How to get started
          </p>
          <h2
            className="text-4xl md:text-5xl lg:text-6xl max-w-2xl"
            style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
          >
            Application to live{" "}
            <span className="italic" style={{ color: "rgba(237,232,223,0.35)" }}>
              in three steps.
            </span>
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-px mb-16"
          style={{ background: "rgba(255,255,255,0.05)" }}
        >
          {STEPS.map(({ n, title, body }) => (
            <div
              key={n}
              className="p-8 lg:p-10"
              style={{ background: "#0a0908" }}
            >
              <span
                className="block text-5xl mb-6"
                style={{ fontFamily: "var(--font-display)", color: "rgba(61,139,255,0.2)" }}
              >
                {n}
              </span>
              <h3
                className="text-xl font-semibold mb-4"
                style={{ color: "#ede8df" }}
              >
                {title}
              </h3>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(237,232,223,0.48)" }}>
                {body}
              </p>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/apply"
            className="land-btn-primary inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold"
          >
            Apply now →
          </Link>
          <a
            href="mailto:hello@matflow.studio"
            className="land-btn-ghost inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold"
          >
            Email us first
          </a>
        </div>
      </div>
    </section>
  );
}
