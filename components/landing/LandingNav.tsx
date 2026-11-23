"use client";

// One of the landing page's two client islands (the other is the member door):
// a scroll-elevation listener and the phone menu. Entrance motion is CSS
// (`land-rise` in globals.css).

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import shortLogo from "@/brand/matflow-short-on-dark.svg";
import shortLogoSmall from "@/brand/matflow-short-small-on-dark.svg";

const SECTION_LINKS = [
  { href: "/#features", label: "What you get" },
  { href: "/#how-it-works", label: "Moving in" },
  { href: "/#pricing", label: "Price" },
] as const;

export function LandingNav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  // The opening shows the full logo large, so the short logo in the bar would
  // only repeat it. It appears once the large one has scrolled under the bar.
  const [pastHeroLogo, setPastHeroLogo] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > 24);
      const heroLogo = document.getElementById("landing-hero-logo");
      // 64 px is the height of the bar. A page without the large logo shows the short one.
      setPastHeroLogo(heroLogo ? heroLogo.getBoundingClientRect().bottom < 64 : true);
    };
    // Once on arrival too: a visitor can land part-way down the page on a section link.
    const first = requestAnimationFrame(onScroll);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(first);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <nav
      aria-label="Main"
      className={`land-nav sticky top-0 z-50 land-rise ${scrolled || open ? "land-nav-solid" : ""}`}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 h-16 flex items-center justify-between gap-4">
        {/* The brand guide gives the striped short logo to widths of 140 px and
            up and the plain-bar version below that, so a phone gets the plain
            bar. Both files carry about 12% of empty margin each side; the
            negative margin lines the lettering up with the page gutter. */}
        <Link
          href="/"
          aria-label="MatFlow.Studio home"
          aria-hidden={pastHeroLogo ? undefined : true}
          tabIndex={pastHeroLogo ? undefined : -1}
          className={`flex items-center shrink-0 transition-opacity duration-300 motion-reduce:transition-none ${
            pastHeroLogo ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
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

        {/* Section links, desktop */}
        <div className="hidden md:flex items-center gap-1">
          {SECTION_LINKS.map(({ href, label }) => (
            <a key={href} href={href} className="land-link px-3.5 py-2 text-sm font-medium rounded-lg">
              {label}
            </a>
          ))}
        </div>

        {/* The two doors: members to their gym, owners to the application. */}
        <div className="flex items-center gap-2">
          <Link
            href="/#find-my-gym"
            className="land-btn-ghost inline-flex items-center px-4 min-h-11 rounded-xl text-sm font-semibold"
          >
            Find my gym
          </Link>
          <Link
            href="/apply"
            className="land-btn-primary hidden sm:inline-flex items-center px-5 min-h-11 rounded-xl text-sm font-semibold"
          >
            Apply
          </Link>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="landing-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            className="land-menu-toggle md:hidden w-11 h-11 rounded-xl flex flex-col items-center justify-center gap-[5px]"
          >
            <span className="land-menu-bar" style={{ transform: open ? "translateY(3px) rotate(45deg)" : "none" }} />
            <span className="land-menu-bar" style={{ transform: open ? "translateY(-3px) rotate(-45deg)" : "none" }} />
          </button>
        </div>
      </div>

      {/* Phone menu */}
      {open && (
        <div id="landing-menu" className="land-rule md:hidden px-6 pb-5 pt-2 flex flex-col gap-1">
          {SECTION_LINKS.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className="land-link px-2 py-3 text-base font-medium rounded-lg"
            >
              {label}
            </a>
          ))}
          <Link
            href="/apply"
            onClick={() => setOpen(false)}
            className="land-btn-primary mt-2 inline-flex items-center justify-center px-5 min-h-12 rounded-xl text-base font-semibold"
          >
            Apply for your club
          </Link>
        </div>
      )}
    </nav>
  );
}
