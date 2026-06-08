import Link from "next/link";

const NAV_LINKS = [
  { href: "/legal/terms", label: "Terms", external: false },
  { href: "/legal/privacy", label: "Privacy", external: false },
  { href: "/legal/subprocessors", label: "Subprocessors", external: false },
  { href: "mailto:hello@matflow.io", label: "Contact", external: true },
] as const;

export function LandingFooter() {
  return (
    <footer
      style={{
        borderTop: "1px solid rgba(255,255,255,0.05)",
        background: "#0a0908",
      }}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-10 flex flex-wrap items-center justify-between gap-6">
        <div className="flex items-center gap-2.5">
          <div
            className="w-6 h-6 rounded-md flex items-center justify-center font-bold text-[10px] shrink-0"
            style={{ background: "#3d8bff", color: "#0a0908", fontFamily: "var(--font-label)" }}
          >
            M
          </div>
          <span className="text-sm" style={{ color: "rgba(237,232,223,0.35)" }}>
            © 2026 MatFlow
          </span>
        </div>

        <nav className="flex flex-wrap gap-6">
          {NAV_LINKS.map(({ href, label, external }) =>
            external ? (
              <a
                key={label}
                href={href}
                className="text-sm opacity-35 hover:opacity-75 transition-opacity duration-200"
                style={{ color: "#ede8df" }}
              >
                {label}
              </a>
            ) : (
              <Link
                key={label}
                href={href}
                className="text-sm opacity-35 hover:opacity-75 transition-opacity duration-200"
                style={{ color: "#ede8df" }}
              >
                {label}
              </Link>
            ),
          )}
        </nav>
      </div>
    </footer>
  );
}
