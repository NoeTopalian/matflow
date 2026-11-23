// Server component. The opening has two doors side by side: the owner's on the
// left (apply), the member's on the right (club code). Entrance motion is CSS
// (`land-rise` in globals.css).

import Image from "next/image";
import Link from "next/link";
import mainLogo from "@/brand/matflowstudio-logo-on-dark.svg";
import { MemberDoor } from "@/components/landing/MemberDoor";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 pt-14 pb-20 lg:pt-20 lg:pb-28">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-14 lg:gap-12 items-center">
          <div className="lg:col-span-7">
            {/* The file is 640 x 260 with the logo in the middle 56% of its
                width, so it is drawn wider than the column and pulled left and
                up by its own empty margin; the section clips the overhang. */}
            <div className="mb-8 land-rise">
              <Image
                src={mainLogo}
                alt="MatFlow.Studio"
                width={560}
                height={228}
                unoptimized
                priority
                style={{
                  width: "min(35rem, 135%)",
                  maxWidth: "none",
                  height: "auto",
                  marginLeft: "calc(min(35rem, 135%) * -0.215)",
                  marginTop: "calc(min(35rem, 135%) * -0.09)",
                }}
              />
            </div>

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
