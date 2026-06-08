const PILLARS = [
  {
    value: "BJJ-native",
    label: "Built for the sport",
    detail: "Belt, stripe and grading vocabulary baked into the data model — not bolted on from a generic gym template.",
  },
  {
    value: "RLS-isolated",
    label: "Your data, only yours",
    detail: "Postgres Row-Level Security on top of application-layer scoping. Another gym's data cannot touch yours.",
  },
  {
    value: "Stripe Connect",
    label: "Your own account",
    detail: "Payments flow through your Stripe account, not ours. Your money, your dashboard, your reconciliation.",
  },
] as const;

export function SocialProofStrip() {
  return (
    <section
      style={{
        background: "#111009",
        borderTop: "1px solid rgba(255,255,255,0.05)",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-8">
          {PILLARS.map(({ value, label, detail }, i) => (
            <div
              key={value}
              className="relative"
              style={{
                paddingLeft: "1.5rem",
                borderLeft: i > 0 ? "1px solid rgba(255,255,255,0.06)" : undefined,
              }}
            >
              <div
                className="absolute left-0 top-0 w-0.5 h-8 rounded-full"
                style={{ background: "#3d8bff", display: i === 0 ? "block" : "none" }}
              />
              <p
                className="text-2xl font-bold mb-1"
                style={{ color: "#3d8bff", fontFamily: "var(--font-display)" }}
              >
                {value}
              </p>
              <p
                className="text-sm font-semibold mb-3 uppercase tracking-widest"
                style={{ color: "rgba(237,232,223,0.45)", fontFamily: "var(--font-label)" }}
              >
                {label}
              </p>
              <p className="text-sm leading-relaxed" style={{ color: "rgba(237,232,223,0.5)" }}>
                {detail}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
