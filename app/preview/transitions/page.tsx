import Link from "next/link";
import { ArrowRight, Sparkles, Zap, Layers, Brush } from "lucide-react";

const STYLES = [
  {
    slug: "fade",
    label: "Fade & scale",
    icon: Layers,
    desc: "Notion / Linear style. Cross-fade with a subtle 0.985 → 1.0 scale lift. Quiet, professional, doesn't draw attention.",
    feel: "Quiet professional",
    weight: "Lightest — pure CSS",
  },
  {
    slug: "slide",
    label: "Native slide",
    icon: ArrowRight,
    desc: "Pages slide horizontally like a real iOS app. Forward push, back swipes the other way. Most distinctive.",
    feel: "Native app",
    weight: "Heaviest — framer-motion",
  },
  {
    slug: "instant",
    label: "Instant + skeleton",
    icon: Zap,
    desc: "No animation. Skeleton placeholders render immediately, real content fades in over 140ms. The 'fast' kind of satisfying.",
    feel: "Snappy",
    weight: "Lightest — Suspense + CSS",
  },
  {
    slug: "wash",
    label: "Branded wash",
    icon: Brush,
    desc: "A coloured sheen sweeps across the screen during navigation in your gym's primary colour. Distinctive, brand-forward.",
    feel: "Branded",
    weight: "Light — CSS keyframes",
  },
] as const;

export default function TransitionsLandingPage() {
  return (
    <div style={{ background: "var(--bg)", minHeight: "100vh", color: "var(--tx-1)" }}>
      <div className="max-w-3xl mx-auto px-5 py-10">
        <div className="mb-8">
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold tracking-wider uppercase mb-4" style={{ background: "var(--color-primary-dim)", color: "var(--color-primary)" }}>
            <Sparkles className="w-3 h-3" /> Sandbox
          </div>
          <h1 className="text-3xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Page transition styles
          </h1>
          <p className="text-sm mt-2 max-w-prose" style={{ color: "var(--tx-3)" }}>
            Tap each style to feel it. Each variant navigates between two demo screens (list ↔ detail) so you can compare like-for-like. Pick the one that feels right and we&apos;ll roll it out across all of MatFlow.
          </p>
        </div>

        <div className="space-y-3">
          {STYLES.map((s) => (
            <Link
              key={s.slug}
              href={`/preview/transitions/${s.slug}/list`}
              className="block rounded-2xl border p-5 transition-all active:scale-[0.99] hover:brightness-110"
              style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
            >
              <div className="flex items-start gap-4">
                <div
                  className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center"
                  style={{ background: "var(--color-primary-dim)" }}
                >
                  <s.icon className="w-5 h-5" style={{ color: "var(--color-primary)" }} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h2 className="font-semibold text-base" style={{ color: "var(--tx-1)" }}>{s.label}</h2>
                    <span className="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded" style={{ background: "var(--sf-2)", color: "var(--tx-3)" }}>
                      {s.feel}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed mb-2" style={{ color: "var(--tx-3)" }}>{s.desc}</p>
                  <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>{s.weight}</p>
                </div>
                <ArrowRight className="w-5 h-5 shrink-0 mt-1" style={{ color: "var(--tx-4)" }} />
              </div>
            </Link>
          ))}
        </div>

        <div className="mt-8 rounded-2xl border p-5" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--tx-1)" }}>How to compare</h3>
          <ol className="space-y-1.5 text-sm" style={{ color: "var(--tx-3)" }}>
            <li>1. Open this page on your <strong>phone</strong> AND your <strong>laptop</strong> — the same transition can feel very different on each.</li>
            <li>2. Tap into a style. The chip-bar at the top stays — use it to hop between styles without going back to this landing page.</li>
            <li>3. Navigate <em>list → detail → list → detail</em> a few times to feel the rhythm.</li>
            <li>4. Tell me which one wins. The next commit rolls it out everywhere.</li>
          </ol>
        </div>
      </div>
    </div>
  );
}
