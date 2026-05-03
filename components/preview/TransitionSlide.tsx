"use client";

import { motion, AnimatePresence, MotionConfig } from "framer-motion";
import { usePathname } from "next/navigation";

/**
 * Native-app horizontal slide using framer-motion AnimatePresence.
 * "list" pushes left → "detail" enters from the right; back nav
 * exits the other direction. Detected from the URL segment.
 *
 * MotionConfig with reducedMotion="user" honours prefers-reduced-motion
 * automatically (collapses the slide to instant).
 */
export default function TransitionSlide({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isDetail = pathname.endsWith("/detail");
  const direction = isDetail ? 1 : -1;

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative overflow-hidden" style={{ minHeight: "70vh" }}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={pathname}
            initial={{ x: direction * 60, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: direction * -40, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32, mass: 0.6 }}
          >
            {children}
          </motion.div>
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
