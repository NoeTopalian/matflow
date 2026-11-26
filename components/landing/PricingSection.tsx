// Server component, no JS shipped for this section.

import Link from "next/link";

const TERMS = ["30-day free trial", "No setup fee", "Cancel anytime"] as const;

export function PricingSection() {
  return (
    <section id="pricing" className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <h2 className="land-display text-4xl sm:text-5xl mb-10">Price</h2>

        <div className="land-card p-6 sm:p-10 flex flex-col lg:flex-row lg:items-center gap-8 lg:gap-12">
          <p className="shrink-0">
            <span className="land-faint block text-sm font-semibold mb-1">From</span>
            <span className="land-display text-6xl sm:text-7xl leading-none">£89</span>
            <span className="land-muted text-lg ml-2">a month</span>
          </p>

          <ul className="flex-1 flex flex-col sm:flex-row sm:flex-wrap gap-x-8 gap-y-2">
            {TERMS.map((term) => (
              <li key={term} className="land-muted text-base">
                {term}
              </li>
            ))}
          </ul>

          <Link
            href="/apply"
            className="land-btn-primary shrink-0 inline-flex items-center justify-center px-8 min-h-12 rounded-xl text-base font-semibold"
          >
            Apply for your club
          </Link>
        </div>
      </div>
    </section>
  );
}
