// Server component, no JS shipped for this section. Both doors once more.

import Link from "next/link";

export function FinalCTA() {
  return (
    <section className="land-rule">
      <div className="max-w-4xl mx-auto px-6 lg:px-10 py-24 lg:py-32 text-center">
        <h2 className="land-display text-5xl sm:text-6xl lg:text-7xl leading-[1.02] mb-6">
          Bring your club over.
        </h2>
        <p className="land-muted text-lg mb-10 max-w-xl mx-auto">
          Apply today and we will reply within one working day.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link
            href="/apply"
            className="land-btn-primary inline-flex items-center px-8 min-h-12 rounded-xl text-base font-semibold"
          >
            Apply for your club
          </Link>
          <Link
            href="/#find-my-gym"
            className="land-btn-ghost inline-flex items-center px-8 min-h-12 rounded-xl text-base font-semibold"
          >
            Find my gym
          </Link>
        </div>
      </div>
    </section>
  );
}
