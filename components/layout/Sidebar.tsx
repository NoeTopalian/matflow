"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Calendar,
  Award,
  ClipboardList,
  Bell,
  BarChart2,
  Settings,
  QrCode,
  BrainCircuit,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/members", label: "Members", icon: Users, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/timetable", label: "Timetable", icon: Calendar, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/attendance", label: "Attendance", icon: ClipboardList, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/checkin", label: "Check-In", icon: QrCode, roles: ["owner", "manager", "admin"] },
  { href: "/dashboard/ranks", label: "Ranks", icon: Award, roles: ["owner", "manager", "coach"] },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell, roles: ["owner", "manager"] },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart2, roles: ["owner", "manager"] },
  { href: "/dashboard/analysis", label: "Analysis", icon: BrainCircuit, roles: ["owner"] },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, roles: ["owner"] },
];

const mainNav = navItems.slice(0, 5);
const adminNav = navItems.slice(5);

interface SidebarProps {
  role: string;
  tenantName: string;
  plan?: string;
  logoUrl?: string;
}

export default function Sidebar({ role, tenantName, plan, logoUrl }: SidebarProps) {
  const pathname = usePathname();
  const visibleMain = mainNav.filter((item) => item.roles.includes(role));
  const visibleAdmin = adminNav.filter((item) => item.roles.includes(role));

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
          <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 flex items-center justify-center"
            style={!logoUrl ? { background: "var(--color-primary)", boxShadow: "0 4px 12px var(--color-primary-dim)" } : undefined}
          >
            {logoUrl ? (
              <Image
                src={logoUrl}
                alt={tenantName}
                width={40}
                height={40}
                className="w-full h-full object-cover"
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
              className="font-bold text-sm truncate block leading-tight"
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
  item: (typeof navItems)[0];
  pathname: string;
}) {
  const active =
    item.href === "/dashboard"
      ? pathname === "/dashboard"
      : pathname.startsWith(item.href);

  return (
    <Link
      href={item.href}
      className={cn(
        "flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all",
        "focus-visible:outline-none focus-visible:ring-2",
        active ? "" : "hover:bg-white/5"
      )}
      style={
        active
          ? {
              background: "var(--color-primary-dim)",
              color: "var(--color-primary)",
              borderLeft: "2px solid var(--color-primary)",
              paddingLeft: "10px",
            }
          : { color: "var(--tx-3)" }
      }
      onMouseEnter={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = "var(--tx-2)";
      }}
      onMouseLeave={(e) => {
        if (!active) (e.currentTarget as HTMLElement).style.color = "var(--tx-3)";
      }}
    >
      <item.icon className="w-4 h-4 shrink-0" />
      <span>{item.label}</span>
    </Link>
  );
}
