"use client";

import Link from "next/link";
import { useParams, usePathname } from "next/navigation";

const STYLES = [
  { slug: "fade",    label: "Fade",     desc: "Notion / Linear style" },
  { slug: "slide",   label: "Slide",    desc: "Native iOS feel"        },
  { slug: "instant", label: "Instant",  desc: "No anim + skeleton"     },
  { slug: "wash",    label: "Wash",     desc: "Branded colour wipe"    },
] as const;

export default function TransitionSandboxNav() {
  const params = useParams<{ style?: string; screen?: string }>();
  const pathname = usePathname();
  const currentStyle = params?.style ?? "fade";
  // Preserve which screen we're on when switching styles
  const currentScreen = params?.screen ?? "list";

  const onLanding = pathname === "/preview/transitions";

  return (
    <div className="sticky top-0 z-50 backdrop-blur-md" style={{ background: "rgba(10,11,14,0.85)", borderBottom: "1px solid var(--bd-default)" }}>
      <div className="max-w-3xl mx-auto px-5 py-3">
        <div className="flex items-center justify-between mb-2">
          <Link href="/preview/transitions" className="text-[11px] font-semibold tracking-wide" style={{ color: "var(--tx-3)" }}>
            ← Sandbox
          </Link>
          <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--tx-4)" }}>
            Transition demo
          </span>
        </div>
        <div className="flex gap-2 overflow-x-auto scrollbar-hide -mx-5 px-5 pb-1">
          {STYLES.map((s) => {
            const active = !onLanding && currentStyle === s.slug;
            return (
              <Link
                key={s.slug}
                href={`/preview/transitions/${s.slug}/${currentScreen}`}
                className="flex flex-col shrink-0 px-3.5 py-2 rounded-xl border transition-all"
                style={{
                  background: active ? "var(--color-primary-dim)" : "var(--sf-1)",
                  borderColor: active ? "var(--color-primary)" : "var(--bd-default)",
                  color: active ? "var(--color-primary)" : "var(--tx-2)",
                }}
              >
                <span className="text-xs font-semibold leading-tight">{s.label}</span>
                <span className="text-[10px] leading-tight opacity-70">{s.desc}</span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
