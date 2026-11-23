import Image from "next/image";
import Link from "next/link";
import mfIcon from "@/brand/app-icon-mf-plain.svg";

const NAV_LINKS = [
  { href: "/legal/terms", label: "Terms", external: false },
  { href: "/legal/privacy", label: "Privacy", external: false },
  { href: "/legal/aup", label: "Acceptable use", external: false },
  { href: "/legal/subprocessors", label: "Subprocessors", external: false },
  { href: "mailto:hello@matflow.studio", label: "Contact", external: true },
] as const;

export function LandingFooter() {
  return (
    <footer className="land-rule">
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-10 flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-2.5">
          <Image src={mfIcon} alt="" width={24} height={24} unoptimized className="shrink-0" />
          <span className="land-faint text-sm">© 2026 MatFlow.Studio</span>
        </div>

        <nav aria-label="Legal and contact" className="flex flex-wrap gap-x-6 gap-y-2">
          {NAV_LINKS.map(({ href, label, external }) =>
            external ? (
              <a key={label} href={href} className="land-link text-sm py-2">
                {label}
              </a>
            ) : (
              <Link key={label} href={href} className="land-link text-sm py-2">
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
