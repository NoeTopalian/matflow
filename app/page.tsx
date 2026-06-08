// Public marketing landing page at matflow.studio.
// Server component that composes client-island sections.
// Proxy.ts must treat `/` as public — see lib/proxy logic.

import type { Metadata } from "next";
import { DM_Serif_Display, Syne, Figtree } from "next/font/google";
import { LandingNav } from "@/components/landing/LandingNav";
import { Hero } from "@/components/landing/Hero";
import { SocialProofStrip } from "@/components/landing/SocialProofStrip";
import { FeaturesGrid } from "@/components/landing/FeaturesGrid";
import { PricingSection } from "@/components/landing/PricingSection";
import { ApplySection } from "@/components/landing/ApplySection";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { LandingFooter } from "@/components/landing/LandingFooter";

const displayFont = DM_Serif_Display({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-display",
  display: "swap",
});

const labelFont = Syne({
  subsets: ["latin"],
  variable: "--font-label",
  display: "swap",
});

const bodyFont = Figtree({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MatFlow — Gym software built for BJJ academies",
  description:
    "Belt and stripe tracking, kiosk check-in, attendance-driven promotions, branded member portal. Built specifically for UK Brazilian Jiu-Jitsu academies.",
};

export default function LandingPage() {
  return (
    <main
      className={`${displayFont.variable} ${labelFont.variable} ${bodyFont.variable} min-h-screen antialiased`}
      style={{
        background: "#0a0908",
        color: "#ede8df",
        fontFamily: "var(--font-body), system-ui, sans-serif",
      } as React.CSSProperties}
    >
      <LandingNav />
      <Hero />
      <SocialProofStrip />
      <FeaturesGrid />
      <PricingSection />
      <ApplySection />
      <FinalCTA />
      <LandingFooter />
    </main>
  );
}
