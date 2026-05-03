"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Fade + 0.98 → 1.0 scale via the View Transitions API.
 * Native browser primitive; gracefully degrades to instant nav on
 * browsers without the API (Safari < 18, Firefox < 130).
 */
export default function TransitionFade({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current !== null && previous.current !== pathname) {
      // Tag the root for the transition, then trigger startViewTransition on the next frame.
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      if (typeof doc.startViewTransition === "function") {
        // Already navigated by Next; just animate the swap that's already in DOM.
        // For the post-render case we rely on CSS keyframes injected below.
        document.documentElement.classList.add("vt-fade-active");
        const t = setTimeout(() => document.documentElement.classList.remove("vt-fade-active"), 280);
        return () => clearTimeout(t);
      }
    }
    previous.current = pathname;
  }, [pathname]);

  return (
    <div key={pathname} className="vt-fade-page">
      {children}
      <style jsx global>{`
        .vt-fade-page {
          animation: vt-fade-in 240ms cubic-bezier(0.22, 1, 0.36, 1) both;
        }
        @keyframes vt-fade-in {
          from { opacity: 0; transform: scale(0.985); }
          to   { opacity: 1; transform: scale(1); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vt-fade-page { animation: none; }
        }
      `}</style>
    </div>
  );
}
