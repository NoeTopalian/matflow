// Server component, no JS shipped for this section.

const STEPS = [
  {
    title: "Apply",
    body: "Tell us about your club. We reply within one working day and arrange a short call.",
  },
  {
    title: "Send your member list",
    body: "Send the export from the system you use now. We import your members, set up your classes and add your logo and colours.",
  },
  {
    title: "Open the doors",
    body: "You get your club code, your members sign in, and we are on hand while you settle in.",
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-20 lg:py-28">
        <h2 className="land-display text-4xl sm:text-5xl mb-4">How we move you in</h2>
        <p className="land-muted text-lg max-w-2xl mb-12">You do not set it up alone.</p>

        <ol className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8">
          {STEPS.map(({ title, body }, i) => (
            <li key={title} className="land-step pt-6">
              <span aria-hidden className="land-display land-step-number block text-5xl mb-4">
                {i + 1}
              </span>
              <h3 className="land-display text-2xl mb-3">{title}</h3>
              <p className="land-muted text-base leading-relaxed">{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
