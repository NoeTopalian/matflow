import { Shield, Layers, CreditCard } from "lucide-react";

const TILES = [
  {
    icon: Shield,
    title: "Built for BJJ",
    body: "Belt, stripe and grading vocabulary baked into the data model. Not bolted on.",
    accent: "from-indigo-500 to-blue-500",
    tint: "bg-indigo-50 text-indigo-700",
  },
  {
    icon: Layers,
    title: "Multi-tenant RLS",
    body: "Postgres Row-Level Security in addition to application-layer scoping. Your data can't leak to another gym.",
    accent: "from-violet-500 to-fuchsia-500",
    tint: "bg-violet-50 text-violet-700",
  },
  {
    icon: CreditCard,
    title: "Stripe Connect per-gym",
    body: "Your own Stripe account, your money, your dashboard. We never touch member payments.",
    accent: "from-sky-500 to-cyan-500",
    tint: "bg-sky-50 text-sky-700",
  },
] as const;

export function SocialProofStrip() {
  return (
    <section className="border-y border-slate-200 bg-gradient-to-b from-white via-slate-50 to-white">
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {TILES.map(({ icon: Icon, title, body, accent, tint }) => (
            <div key={title} className="text-center flex flex-col items-center">
              <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${accent} text-white flex items-center justify-center shadow-lg mb-5`}>
                <Icon className="w-6 h-6" aria-hidden />
              </div>
              <h3 className={`inline-flex px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${tint} mb-3`}>
                {title}
              </h3>
              <p className="text-sm text-slate-600 leading-relaxed max-w-xs">{body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
