// Public marketing landing page at matflow.studio.
// Server component; the only client islands are the top bar and the member door.
// Proxy.ts must treat `/` as public — see lib/proxy logic.

import type { Metadata } from "next";
import { Inter, Protest_Strike } from "next/font/google";
import { LandingNav } from "@/components/landing/LandingNav";
import { Hero } from "@/components/landing/Hero";
import { FeaturesGrid } from "@/components/landing/FeaturesGrid";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PricingSection } from "@/components/landing/PricingSection";
import { FinalCTA } from "@/components/landing/FinalCTA";
import { LandingFooter } from "@/components/landing/LandingFooter";

// The two faces the brand guide names beside the logo (brand/MATFLOW-STUDIO-LOGO-GUIDE.md).
const displayFont = Protest_Strike({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

const bodyFont = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const TITLE = "MatFlow.Studio: Gym management software for martial arts academies";
const DESCRIPTION =
  "Timetable, check-in, belts and members in one place. Built for martial arts academies in the UK.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "https://matflow.studio",
    siteName: "MatFlow.Studio",
    locale: "en_GB",
    type: "website",
  },
  twitter: {
    card: "summary",
  },
};

// Colours and type for this page are defined once, under #landing-root in app/globals.css.
export default function LandingPage() {
  return (
    <main
      id="landing-root"
      className={`${displayFont.variable} ${bodyFont.variable} min-h-screen antialiased`}
    >
      <LandingNav />
      <Hero />
      <FeaturesGrid />
      <HowItWorks />
      <PricingSection />
      <FinalCTA />
      <LandingFooter />
    </main>
  );
}
