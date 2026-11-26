// Server component. The opening has two doors side by side: the owner's on the
// left (apply), the member's on the right (club code). Entrance motion is CSS
// (`land-rise` in globals.css).

import Image from "next/image";
import Link from "next/link";
import mainLogo from "@/brand/matflowstudio-logo-on-light.svg";
import { MemberDoor } from "@/components/landing/MemberDoor";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-14 pb-20 lg:pt-20 lg:pb-28">
        {/* The logo, large and centred above both doors, written out on arrival:
            the lettering and belt first, then the .Studio strip (the two
            copies and their cuts are explained in globals.css). The file is
            640 x 260 with the drawing in the middle 56% of its width, so the
            stage is wider than the page column (a centred flex child overflows
            equally on both sides) and its empty top and bottom margins are
            pulled in; the section clips the overhang. */}
        <div id="landing-hero-logo" className="flex justify-center mb-10 lg:mb-14">
          <div
            className="relative shrink-0"
            style={{
              width: "min(65rem, 165%)",
              aspectRatio: "640 / 260",
              marginTop: "calc(min(65rem, 165%) * -0.085)",
              marginBottom: "calc(min(65rem, 165%) * -0.03)",
            }}
          >
            <div className="absolute inset-0 land-write-word">
              <Image
                src={mainLogo}
                alt="MatFlow.Studio"
                width={1040}
                height={423}
                unoptimized
                preload
                className="land-logo-word block w-full h-full max-w-none"
              />
            </div>
            <div className="absolute inset-0 land-write-strip" aria-hidden>
              <Image
                src={mainLogo}
                alt=""
                width={1040}
                height={423}
                unoptimized
                className="land-logo-strip block w-full h-full max-w-none"
              />
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-14 lg:gap-12 items-center">
          <div className="lg:col-span-7">
            <h1 className="land-display text-5xl sm:text-6xl lg:text-7xl leading-[1.02] mb-6 land-rise land-rise-2">
              Run your academy from the mat.
            </h1>

            <p className="land-muted text-lg sm:text-xl leading-relaxed mb-9 max-w-xl land-rise land-rise-3">
              Timetable, check-in, belts and members in one place. Built for martial arts academies
              in the UK.
            </p>

            <div className="flex flex-wrap gap-3 items-center mb-5 land-rise land-rise-4">
              <Link
                href="/apply"
                className="land-btn-primary inline-flex items-center px-7 min-h-12 rounded-xl text-base font-semibold"
              >
                Apply for your club
              </Link>
              <Link
                href="/#features"
                className="land-btn-ghost inline-flex items-center px-7 min-h-12 rounded-xl text-base font-semibold"
              >
                See what you get
              </Link>
            </div>

            <p className="land-faint text-sm land-rise land-rise-5">
              30-day free trial. No card needed to apply.
            </p>
          </div>

          <div className="lg:col-span-5 land-rise land-rise-3">
            <MemberDoor />
          </div>
        </div>
      </div>
    </section>
  );
}
