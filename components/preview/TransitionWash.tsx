"use client";

import { usePathname } from "next/navigation";

/**
 * Branded colour wash — a tinted overlay sweeps across the screen
 * during route changes using `var(--color-primary)`. Pure CSS keyframe
 * triggered by the `key={pathname}` remount on each navigation.
 */
export default function TransitionWash({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div key={pathname} className="vt-wash-wrapper relative">
      <div className="vt-wash-sheen" aria-hidden />
      <div className="vt-wash-content">{children}</div>
      <style jsx global>{`
        .vt-wash-wrapper {
          isolation: isolate;
        }
        .vt-wash-sheen {
          position: fixed;
          inset: 0;
          z-index: 60;
          pointer-events: none;
          background: linear-gradient(115deg,
            transparent 0%,
            transparent 40%,
            var(--color-primary, #3b82f6) 50%,
            transparent 60%,
            transparent 100%);
          opacity: 0;
          transform: translateX(-110%);
          animation: vt-wash-sweep 520ms cubic-bezier(0.4, 0, 0.2, 1) forwards;
          mix-blend-mode: screen;
        }
        .vt-wash-content {
          animation: vt-wash-content 320ms ease-out 80ms both;
        }
        @keyframes vt-wash-sweep {
          0%   { transform: translateX(-110%); opacity: 0; }
          30%  { opacity: 0.6; }
          100% { transform: translateX(110%); opacity: 0; }
        }
        @keyframes vt-wash-content {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .vt-wash-sheen, .vt-wash-content { animation: none; }
          .vt-wash-sheen { display: none; }
        }
      `}</style>
    </div>
  );
}
