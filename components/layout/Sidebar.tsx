"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { STAFF_NAV, isNavActive, type StaffNavItem, type StaffRole } from "@/components/layout/routes";

const mainNav = STAFF_NAV.filter((item) => item.section === "main");
const adminNav = STAFF_NAV.filter((item) => item.section === "admin");

interface SidebarProps {
  role: string;
  tenantName: string;
  plan?: string;
  logoUrl?: string;
  logoSize?: "sm" | "md" | "lg";
}

const LOGO_PX: Record<string, number> = { sm: 32, md: 56, lg: 64 };

export default function Sidebar({ role, tenantName, plan, logoUrl, logoSize = "md" }: SidebarProps) {
  const pathname = usePathname();
  // H13: normalise the role so a casing/whitespace slip (e.g. "Owner") doesn't
  // silently render an empty sidebar; warn in dev on a genuinely unknown role.
  const KNOWN_ROLES = ["owner", "manager", "coach", "admin", "member"];
  const normalizedRole = (role ?? "").toLowerCase().trim();
  if (process.env.NODE_ENV !== "production" && !KNOWN_ROLES.includes(normalizedRole)) {
    console.warn(
      `[Sidebar] Unrecognised role "${role}" — navigation will be empty. ` +
        `Expected one of: ${KNOWN_ROLES.join(", ")}.`,
    );
  }
  // Cast is safe: an unknown role simply matches no manifest entries (and
  // warns above in dev) — same handling as MobileNav.
  const visibleMain = mainNav.filter((item) => item.roles.includes(normalizedRole as StaffRole));
  const visibleAdmin = adminNav.filter((item) => item.roles.includes(normalizedRole as StaffRole));

  return (
    <aside
      className="w-60 flex flex-col shrink-0 border-r"
      style={{
        background: "var(--sf-0)",
        borderColor: "var(--bd-default)",
      }}
    >
      {/* Gym branding */}
      <div
        className="px-4 py-4 border-b"
        style={{ borderColor: "var(--bd-default)" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="rounded-xl overflow-hidden shrink-0 flex items-center justify-center"
            style={{
              width: LOGO_PX[logoSize],
              height: LOGO_PX[logoSize],
              ...(!logoUrl ? { background: "var(--color-primary)", boxShadow: "0 4px 12px var(--color-primary-dim)" } : {}),
            }}
          >
            {logoUrl ? (
              <Image
                src={toBlobProxyUrl(logoUrl) ?? logoUrl}
                alt={tenantName}
                width={LOGO_PX[logoSize]}
                height={LOGO_PX[logoSize]}
                className="w-full h-full object-contain p-1.5"
                unoptimized
              />
            ) : (
              <span className="text-white font-bold text-base">
                {tenantName.charAt(0).toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span
              className="font-bold text-base truncate block leading-tight"
              style={{ color: "var(--tx-1)" }}
            >
              {tenantName}
            </span>
            {plan && (
              <span
                className="inline-flex items-center mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded capitalize"
                style={{ background: "var(--color-primary-dim)", color: "var(--color-primary)" }}
              >
                {plan}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 overflow-y-auto scrollbar-hide space-y-5">
        {/* Main section */}
        <div>
          <p
            className="text-[10px] font-semibold uppercase tracking-widest mb-2 px-2"
            style={{ color: "var(--tx-4)" }}
          >
            Main
          </p>
          <div className="space-y-0.5">
            {visibleMain.map((item) => (
              <NavItem key={item.href} item={item} pathname={pathname} />
            ))}
          </div>
        </div>

        {/* Admin section */}
        {visibleAdmin.length > 0 && (
          <div>
            <p
              className="text-[10px] font-semibold uppercase tracking-widest mb-2 px-2"
              style={{ color: "var(--tx-4)" }}
            >
              Admin
            </p>
            <div className="space-y-0.5">
              {visibleAdmin.map((item) => (
                <NavItem key={item.href} item={item} pathname={pathname} />
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Footer */}
      <div
        className="px-4 py-3 border-t flex items-center justify-between"
        style={{ borderColor: "var(--bd-default)" }}
      >
        <span className="text-[10px] font-semibold tracking-wider" style={{ color: "var(--tx-4)" }}>
          MatFlow
        </span>
        <span className="text-[10px]" style={{ color: "var(--tx-4)" }}>
          v1.0
        </span>
      </div>
    </aside>
  );
}

function NavItem({
  item,
  pathname,
}: {
  item: StaffNavItem;
  pathname: string;
}) {
  const active = isNavActive(item.href, pathname);

  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all",
        "focus-visible:outline-none focus-visible:ring-2",
        // Hover is CSS, not a JS style mutation: the old onMouseEnter/Leave
        // pair wrote inline colour on every pointer move and never fired for
        // keyboard focus (UI-RULES §4a — token-driven states only).
        active ? "" : "text-tx-3 hover:bg-sf-2 hover:text-tx-2 focus-visible:text-tx-2",
      )}
      style={
        active
          ? {
              background: "var(--color-primary-dim)",
              color: "var(--color-primary)",
              borderLeft: "2px solid var(--color-primary)",
              paddingLeft: "10px",
            }
          : undefined
      }
    >
      <item.icon className="w-4 h-4 shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}
