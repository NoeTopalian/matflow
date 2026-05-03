"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * "Instant + skeleton" feel. No animation — instead, render skeleton
 * placeholders the moment the route changes, then swap in real content
 * on the next paint with a 120ms cross-fade.
 *
 * In a real-app rollout this would integrate with Suspense boundaries
 * + actual data fetches. For the sandbox we simulate the delay so the
 * pattern is visible.
 */
export default function TransitionInstant({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    // Two RAFs to guarantee a skeleton frame is painted before swap.
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setReady(true));
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [pathname]);

  return (
    <div className="relative">
      {!ready && <Skeleton />}
      <div
        style={{
          opacity: ready ? 1 : 0,
          transition: "opacity 140ms ease-out",
        }}
      >
        {children}
      </div>
      <style jsx>{`
        @media (prefers-reduced-motion: reduce) {
          div > div { transition: none !important; }
        }
      `}</style>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="absolute inset-0 max-w-2xl mx-auto px-5 py-6 space-y-4 pointer-events-none">
      <div className="rounded-2xl h-24 animate-pulse" style={{ background: "var(--sf-2)" }} />
      <div className="space-y-2">
        {[0,1,2,3,4,5].map((i) => (
          <div key={i} className="rounded-2xl h-16 animate-pulse" style={{ background: "var(--sf-1)" }} />
        ))}
      </div>
    </div>
  );
}
