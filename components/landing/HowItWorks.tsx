// Server component — the concierge story. The numbering is real sequence
// (this IS the onboarding order), and each step carries a miniature of the
// actual product surface it produces, hand-built in JSX like the hero mock.

const CREAM = "#ede8df";
const MUTED = "rgba(237,232,223,0.5)";
const BLUE = "#3d8bff";
const CARD = "#111009";
const HAIRLINE = "rgba(255,255,255,0.06)";

function StepApplication() {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${HAIRLINE}` }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: BLUE, fontFamily: "var(--font-label)" }}>
          Application
        </p>
      </div>
      <div className="px-4 py-4 space-y-3">
        {[
          ["Gym name", "Apex Academy"],
          ["Discipline", "BJJ · Nogi · Kids"],
          ["Members", "~120"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <span className="text-[11px]" style={{ color: "rgba(237,232,223,0.35)" }}>{k}</span>
            <span className="text-[11px] font-medium" style={{ color: CREAM }}>{v}</span>
          </div>
        ))}
        <div
          className="mt-1 rounded-lg px-3 py-2 text-[11px] font-semibold text-center"
          style={{ background: "rgba(61,139,255,0.12)", color: BLUE }}
        >
          Reviewed within 1 business day
        </div>
      </div>
    </div>
  );
}

function StepSetup() {
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: CARD, border: `1px solid ${HAIRLINE}` }}>
      <div className="px-4 py-3" style={{ borderBottom: `1px solid ${HAIRLINE}` }}>
        <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: BLUE, fontFamily: "var(--font-label)" }}>
          We set it up with you
        </p>
      </div>
      <div className="px-4 py-4 space-y-2.5">
        {[
          ["Members imported from your old system", true],
          ["Belts & stripes recorded", true],
          ["Logo, colours and font applied", true],
          ["Payments connected to YOUR Stripe", false],
        ].map(([label, done]) => (
          <div key={String(label)} className="flex items-center gap-2.5">
            <span
              className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] shrink-0"
              style={{
                background: done ? "rgba(34,197,94,0.15)" : "rgba(255,255,255,0.06)",
                color: done ? "#22c55e" : "rgba(237,232,223,0.3)",
              }}
              aria-hidden
            >
              {done ? "✓" : "…"}
            </span>
            <span className="text-[11px]" style={{ color: done ? CREAM : MUTED }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepMemberPhone() {
  return (
    <div
      className="rounded-[1.4rem] overflow-hidden mx-auto"
      style={{ background: "#0e0d0b", border: `1px solid rgba(255,255,255,0.1)`, width: 168, boxShadow: "0 20px 50px rgba(0,0,0,0.5)" }}
    >
      {/* Phone status strip */}
      <div className="flex justify-center pt-2 pb-1">
        <div className="w-12 h-1 rounded-full" style={{ background: "rgba(255,255,255,0.12)" }} />
      </div>
      <div className="px-3 pb-3">
        <p className="text-[9px] font-bold text-center mb-2 tracking-wide" style={{ color: CREAM }}>
          APEX ACADEMY
        </p>
        <div className="rounded-lg px-2.5 py-2 mb-1.5" style={{ background: "rgba(61,139,255,0.1)", border: "1px solid rgba(61,139,255,0.2)" }}>
          <p className="text-[8px] mb-0.5" style={{ color: MUTED }}>Tonight · 18:30</p>
          <p className="text-[10px] font-semibold" style={{ color: CREAM }}>Fundamentals</p>
          <div className="mt-1.5 rounded-md py-1 text-center text-[9px] font-bold" style={{ background: BLUE, color: "#0a0908" }}>
            Check in
          </div>
        </div>
        <div className="rounded-lg px-2.5 py-2 flex items-center justify-between" style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${HAIRLINE}` }}>
          <span className="text-[8px]" style={{ color: MUTED }}>Streak</span>
          <span className="text-[10px] font-bold" style={{ color: "#e8b86d" }}>6 classes</span>
        </div>
        {/* Tab bar */}
        <div className="mt-2 flex justify-around pt-1.5" style={{ borderTop: `1px solid ${HAIRLINE}` }}>
          {["●", "○", "○", "○"].map((dot, i) => (
            <span key={i} className="text-[8px]" style={{ color: i === 0 ? BLUE : "rgba(237,232,223,0.25)" }}>{dot}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

const STEPS = [
  {
    num: "1",
    title: "Apply",
    body: "Five fields, two minutes. We reply within one business day and jump on a short call to make sure MatFlow fits how you run your academy.",
    visual: <StepApplication />,
  },
  {
    num: "2",
    title: "We set everything up with you",
    body: "Send us your member list — any format. We import it, record belts and stripes, apply your branding, and connect payments to your own Stripe account. You watch it happen; you don't do it alone.",
    visual: <StepSetup />,
  },
  {
    num: "3",
    title: "Your members get the app",
    body: "Everyone receives a login invite to your branded member app — schedule, check-in, rank progress. The iPad kiosk goes by the door. Training carries on; the admin disappears.",
    visual: <StepMemberPhone />,
  },
] as const;

export function HowItWorks() {
  return (
    <section id="how-it-works" className="max-w-7xl mx-auto px-6 lg:px-10 py-24 lg:py-32">
      <div className="mb-16 lg:mb-20">
        <p
          className="text-xs font-semibold uppercase tracking-[0.18em] mb-4"
          style={{ color: BLUE, fontFamily: "var(--font-label)" }}
        >
          How it works
        </p>
        <h2
          className="text-4xl md:text-5xl lg:text-6xl leading-tight"
          style={{ fontFamily: "var(--font-display)", color: CREAM }}
        >
          You teach.
          <span className="italic" style={{ color: "rgba(237,232,223,0.35)" }}> We move you in.</span>
        </h2>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-10 lg:gap-8">
        {STEPS.map(({ num, title, body, visual }) => (
          <div key={num} className="flex flex-col">
            <div className="flex items-baseline gap-4 mb-4">
              <span
                className="text-5xl leading-none"
                style={{ fontFamily: "var(--font-display)", color: "rgba(61,139,255,0.35)" }}
              >
                {num}
              </span>
              <h3 className="text-xl font-semibold" style={{ color: CREAM }}>
                {title}
              </h3>
            </div>
            <p className="text-sm leading-relaxed mb-8" style={{ color: "rgba(237,232,223,0.48)" }}>
              {body}
            </p>
            <div className="mt-auto">{visual}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
