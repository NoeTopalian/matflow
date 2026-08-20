// Server component — no JS shipped for this section (speed pass B1).
// Hover states come from the .land-btn-* CSS utilities in globals.css.

import Link from "next/link";

const INCLUDED = [
  "Up to 150 members",
  "Belt and stripe tracking",
  "Kiosk check-in (iPad + QR)",
  "Branded member portal (PWA)",
  "Stripe Connect billing",
  "Attendance-driven promotions",
  "Live reports & exports",
  "White-glove data migration",
  "Email and chat support",
  "30-day free trial",
  "No setup fees",
  "Cancel anytime",
] as const;

export function PricingSection() {
  return (
    <section
      id="pricing"
      style={{
        background: "#0d0c0a",
        borderTop: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="max-w-5xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
        <div className="text-center mb-14">
          <p
            className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
            style={{ color: "#3d8bff", fontFamily: "var(--font-label)" }}
          >
            Pricing
          </p>
          <h2
            className="text-4xl md:text-5xl lg:text-6xl mb-4"
            style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
          >
            One plan.{" "}
            <span className="italic" style={{ color: "rgba(237,232,223,0.35)" }}>
              Everything included.
            </span>
          </h2>
          <p className="text-base" style={{ color: "rgba(237,232,223,0.48)" }}>
            No tiered upsell, no per-seat add-ons. Larger academies — get in touch.
          </p>
        </div>

        <div
          className="rounded-2xl overflow-hidden"
          style={{
            background: "#141210",
            border: "1px solid rgba(255,255,255,0.07)",
            boxShadow: "0 0 0 1px rgba(61,139,255,0.08), 0 40px 80px rgba(0,0,0,0.4)",
          }}
        >
          {/* Gold top accent bar */}
          <div className="h-0.5 w-full" style={{ background: "linear-gradient(90deg, transparent, #3d8bff, transparent)" }} />

          <div className="px-8 md:px-14 py-12 md:py-16">
            {/* Price */}
            <div className="text-center mb-12">
              <div className="flex items-baseline justify-center gap-2 mb-2">
                <span className="text-lg" style={{ color: "rgba(237,232,223,0.4)" }}>From</span>
                <span
                  className="text-7xl md:text-8xl font-bold leading-none"
                  style={{ fontFamily: "var(--font-display)", color: "#ede8df" }}
                >
                  £89
                </span>
                <span className="text-lg" style={{ color: "rgba(237,232,223,0.4)" }}>/ month</span>
              </div>
              <p className="text-sm" style={{ color: "rgba(237,232,223,0.35)" }}>
                For academies up to 150 members
              </p>
            </div>

            {/* Divider */}
            <div className="h-px mb-12" style={{ background: "rgba(255,255,255,0.06)" }} />

            {/* Included list */}
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-3.5 mb-12 max-w-2xl mx-auto">
              {INCLUDED.map((item) => (
                <li key={item} className="flex items-center gap-3 text-sm" style={{ color: "rgba(237,232,223,0.65)" }}>
                  <span
                    className="shrink-0 text-base leading-none"
                    style={{ color: "#3d8bff" }}
                    aria-hidden
                  >
                    ✦
                  </span>
                  {item}
                </li>
              ))}
            </ul>

            {/* CTAs */}
            <div className="flex flex-wrap gap-3 justify-center">
              <Link
                href="/apply"
                className="land-btn-primary inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold"
              >
                Apply for an account →
              </Link>
              <Link
                href="/login"
                className="land-btn-ghost inline-flex items-center gap-2 px-8 py-4 rounded-xl text-base font-semibold"
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
