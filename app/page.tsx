// Public marketing landing page at matflow.studio.
//
// Server component (so we can export metadata) that composes client-island
// sections. Animation lives inside each *.tsx under components/landing/.
//
// Proxy.ts must treat `/` as public — see lib/proxy logic.

import type { Metadata } from "next";
import { LandingNav } from "@/components/landing/LandingNav";
import { Hero } from "@/components/landing/Hero";
import { BigSignInCard } from "@/components/landing/BigSignInCard";
import { SocialProofStrip } from "@/components/landing/SocialProofStrip";
import { FeaturesGrid } from "@/components/landing/FeaturesGrid";
import { PricingSection } from "@/components/landing/PricingSection";
import { ApplySection } from "@/components/landing/ApplySection";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { LandingFooter } from "@/components/landing/LandingFooter";

export const metadata: Metadata = {
  title: "MatFlow — Gym software built for BJJ academies",
  description:
    "Belt and stripe tracking, kiosk check-in, attendance-driven promotions, branded member portal. Built specifically for UK Brazilian Jiu-Jitsu academies.",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-white text-slate-900 antialiased">
      <LandingNav />
      <Hero />
      <BigSignInCard />
      <SocialProofStrip />
      <FeaturesGrid />
      <PricingSection />
      <ApplySection />
      <FinalCTA />
      <LandingFooter />
    </main>
  );
}
