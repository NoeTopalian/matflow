"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { motion } from "framer-motion";

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.nav
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className="sticky top-0 z-50 transition-all duration-500"
      style={{
        background: scrolled ? "rgba(10,9,8,0.90)" : "transparent",
        borderBottom: scrolled ? "1px solid rgba(255,255,255,0.07)" : "1px solid transparent",
        backdropFilter: scrolled ? "blur(20px)" : "none",
        WebkitBackdropFilter: scrolled ? "blur(20px)" : "none",
      }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between">
        <Link href="/" className="flex items-center gap-2.5">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center font-bold text-sm shrink-0"
            style={{ background: "#c4923f", color: "#0a0908", fontFamily: "var(--font-label)" }}
          >
            M
          </div>
          <span
            className="font-semibold text-base tracking-tight"
            style={{ color: "#ede8df", fontFamily: "var(--font-label)" }}
          >
            MatFlow
          </span>
        </Link>

        <div className="flex items-center gap-1">
          <Link
            href="/apply"
            className="hidden sm:inline-flex px-4 py-2 text-sm font-medium rounded-lg transition-colors duration-200"
            style={{ color: "rgba(237,232,223,0.55)", fontFamily: "var(--font-body)" }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "#ede8df"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "rgba(237,232,223,0.55)"; }}
          >
            Apply
          </Link>
          <motion.div whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}>
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all duration-200"
              style={{ background: "#c4923f", color: "#0a0908", fontFamily: "var(--font-body)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#d4a34f"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "#c4923f"; }}
            >
              Sign in
            </Link>
          </motion.div>
        </div>
      </div>
    </motion.nav>
  );
}
