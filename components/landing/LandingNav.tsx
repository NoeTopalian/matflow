"use client";

// The nav is the landing page's ONE client island (plus the apply form):
// a scroll-elevation listener and the mobile disclosure menu. Everything
// heavier (framer-motion) was removed in the speed pass — entrance motion
// is CSS (`land-rise` in globals.css).

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import shortLogo from "@/brand/matflow-short-on-dark.svg";
import shortLogoSmall from "@/brand/matflow-short-small-on-dark.svg";

const SECTION_LINKS = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
] as const;

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <nav
      className="sticky top-0 z-50 transition-all duration-500 land-rise"
      style={{
        background: scrolled || open ? "rgba(10,9,8,0.92)" : "transparent",
        borderBottom: scrolled || open ? "1px solid rgba(255,255,255,0.07)" : "1px solid transparent",
        backdropFilter: scrolled || open ? "blur(20px)" : "none",
        WebkitBackdropFilter: scrolled || open ? "blur(20px)" : "none",
      }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between gap-4">
        {/* The brand guide gives the striped short logo to widths of 140 px and
            up and the plain-bar version below that, so a phone gets the plain
            bar. Both files carry about 12% of empty margin each side; the
            negative margin lines the lettering up with the page gutter. */}
        <Link href="/" aria-label="MatFlow.Studio home" className="flex items-center shrink-0">
          <Image
            src={shortLogoSmall}
            alt="MatFlow.Studio"
            width={131}
            height={48}
            unoptimized
            priority
            className="sm:hidden -ml-4 max-w-none"
          />
          <Image
            src={shortLogo}
            alt="MatFlow.Studio"
            width={175}
            height={64}
            unoptimized
            priority
            className="hidden sm:block -ml-5 max-w-none"
          />
        </Link>

        {/* Section links — desktop */}
        <div className="hidden md:flex items-center gap-1">
          {SECTION_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="land-link px-3.5 py-2 text-sm font-medium rounded-lg"
              style={{ fontFamily: "var(--font-body)" }}
            >
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <Link
            href="/apply"
            className="land-link hidden sm:inline-flex px-4 py-2 text-sm font-medium rounded-lg"
            style={{ fontFamily: "var(--font-body)" }}
          >
            Apply
          </Link>
          <Link
            href="/login"
            className="land-btn-primary inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold"
            style={{ fontFamily: "var(--font-body)" }}
          >
            Sign in
          </Link>
          {/* Mobile menu toggle */}
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? "Close menu" : "Open menu"}
            className="md:hidden ml-1 w-10 h-10 rounded-lg flex flex-col items-center justify-center gap-[5px]"
            style={{ border: "1px solid rgba(255,255,255,0.1)" }}
          >
            <span
              className="block w-4 h-px transition-transform duration-200"
              style={{ background: "#ede8df", transform: open ? "translateY(3px) rotate(45deg)" : "none" }}
            />
            <span
              className="block w-4 h-px transition-transform duration-200"
              style={{ background: "#ede8df", transform: open ? "translateY(-3px) rotate(-45deg)" : "none" }}
            />
          </button>
        </div>
      </div>

      {/* Mobile disclosure menu */}
      {open && (
        <div className="md:hidden px-6 pb-5 pt-1 flex flex-col gap-1" style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          {SECTION_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="land-link px-2 py-3 text-base font-medium rounded-lg"
              style={{ fontFamily: "var(--font-body)" }}
            >
              {label}
            </a>
          ))}
          <Link
            href="/apply"
            onClick={() => setOpen(false)}
            className="land-btn-primary mt-2 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-base font-semibold"
          >
            Apply for an account →
          </Link>
        </div>
      )}
    </nav>
  );
}
