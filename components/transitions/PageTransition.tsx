"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Universal page transition for MatFlow — the "instant" feel chosen
 * from the /preview/transitions sandbox. Two RAFs let the new route's
 * server-rendered content paint, then we cross-fade in over ~140ms.
 *
 * No synthetic skeleton flash, no loading delay — just softens the
 * route swap so it doesn't feel like a hard cut. Respects
 * prefers-reduced-motion (CSS handles that). All client-side: this
 * wraps {children} from app/template.tsx, which Next.js re-instances
 * on every navigation.
 */
export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [phase, setPhase] = useState<"in" | "settled">("in");

  useEffect(() => {
    setPhase("in");
    let r1 = 0, r2 = 0;
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setPhase("settled"));
    });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [pathname]);

  return (
    <div
      data-page-transition={phase}
      style={{
        opacity: phase === "settled" ? 1 : 0,
        transition: "opacity 140ms ease-out",
        // Avoid layout shift while opacity animates
        willChange: phase === "in" ? "opacity" : "auto",
      }}
    >
      {children}
      <style jsx global>{`
        @media (prefers-reduced-motion: reduce) {
          [data-page-transition] {
            transition: none !important;
            opacity: 1 !important;
          }
        }
      `}</style>
    </div>
  );
}
