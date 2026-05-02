"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import {
  LayoutDashboard, Users, Calendar, ClipboardCheck, Award,
  ClipboardList, Bell, BarChart2, Settings, MoreHorizontal,
  LogOut, X, BrainCircuit,
} from "lucide-react";

const PRIMARY_NAV = [
  { href: "/dashboard", label: "Home", icon: LayoutDashboard, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/timetable", label: "Schedule", icon: Calendar, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/members", label: "Members", icon: Users, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/checkin", label: "Mark Attendance", icon: ClipboardCheck, roles: ["owner", "manager", "admin"] },
];

const MORE_NAV = [
  { href: "/dashboard/attendance", label: "Attendance", icon: ClipboardList, roles: ["owner", "manager", "coach", "admin"] },
  { href: "/dashboard/ranks", label: "Ranks", icon: Award, roles: ["owner", "manager", "coach"] },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell, roles: ["owner", "manager"] },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart2, roles: ["owner", "manager"] },
  { href: "/dashboard/analysis", label: "Analysis", icon: BrainCircuit, roles: ["owner"] },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, roles: ["owner"] },
];

interface Props {
  role: string;
  primaryColor: string;
}

export default function MobileNav({ role, primaryColor }: Props) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  const visiblePrimary = PRIMARY_NAV.filter((i) => i.roles.includes(role));
  const visibleMore = MORE_NAV.filter((i) => i.roles.includes(role));
  const isMoreActive = visibleMore.some((i) => pathname.startsWith(i.href));

  function isActive(href: string) {
    return href === "/dashboard" ? pathname === "/dashboard" : pathname.startsWith(href);
  }

  return (
    <>
      {/* Backdrop */}
      {moreOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 md:hidden"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* More sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 md:hidden transition-transform duration-300 ease-out ${
          moreOpen ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ background: "#0e1013", borderTop: "1px solid rgba(255,255,255,0.08)", borderRadius: "20px 20px 0 0" }}
      >
        <div className="flex justify-between items-center px-5 py-4 border-b border-white/5">
          <p className="text-white font-semibold text-sm">More</p>
          <button
            onClick={() => setMoreOpen(false)}
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: "rgba(255,255,255,0.07)" }}
            aria-label="Close menu"
          >
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>
        <div className="px-4 py-3 space-y-1 pb-safe">
          {visibleMore.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMoreOpen(false)}
                className="flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all active:scale-[0.98]"
                style={{
                  background: active ? `${primaryColor}15` : "transparent",
                  color: active ? primaryColor : "rgba(255,255,255,0.55)",
                }}
                aria-current={active ? "page" : undefined}
              >
                <item.icon className="w-5 h-5 shrink-0" />
                <span className="text-sm font-medium">{item.label}</span>
                {active && (
                  <div
                    className="ml-auto w-1.5 h-1.5 rounded-full"
                    style={{ background: primaryColor }}
                  />
                )}
              </Link>
            );
          })}
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl text-red-400 transition-all active:scale-[0.98]"
            style={{ color: "rgba(239,68,68,0.7)" }}
            aria-label="Sign out"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span className="text-sm font-medium">Sign out</span>
          </button>
        </div>
        {/* Safe area padding */}
        <div className="h-6" />
      </div>

      {/* Bottom tab bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 md:hidden flex items-end"
        style={{
          background: "rgba(10,11,14,0.95)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid rgba(255,255,255,0.07)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-around w-full px-2 pt-2 pb-1">
          {visiblePrimary.map((item) => {
            const active = isActive(item.href);
            const isCheckIn = item.href === "/dashboard/checkin";

            if (isCheckIn) {
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex flex-col items-center gap-1 -mt-4"
                  aria-label={item.label}
                  aria-current={active ? "page" : undefined}
                >
                  <div
                    className="w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-90"
                    style={{
                      background: primaryColor,
                      boxShadow: `0 4px 20px ${primaryColor}60`,
                    }}
                  >
                    <item.icon className="w-6 h-6 text-white" />
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: active ? primaryColor : "rgba(255,255,255,0.35)" }}>
                    {item.label}
                  </span>
                </Link>
              );
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex flex-col items-center gap-1 min-w-[52px] min-h-[44px] justify-center transition-transform active:scale-90"
                aria-label={item.label}
                aria-current={active ? "page" : undefined}
              >
                <div className="w-7 h-7 flex items-center justify-center">
                  <item.icon
                    className="w-5 h-5 transition-all"
                    style={{ color: active ? primaryColor : "rgba(255,255,255,0.35)" }}
                    strokeWidth={active ? 2.5 : 1.75}
                  />
                </div>
                <span
                  className="text-[10px] font-medium transition-colors"
                  style={{ color: active ? primaryColor : "rgba(255,255,255,0.35)" }}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}

          {/* More button */}
          {visibleMore.length > 0 && (
            <button
              onClick={() => setMoreOpen(true)}
              className="flex flex-col items-center gap-1 min-w-[52px] min-h-[44px] justify-center transition-transform active:scale-90"
              aria-label="More options"
              aria-expanded={moreOpen}
            >
              <div className="w-7 h-7 flex items-center justify-center">
                <MoreHorizontal
                  className="w-5 h-5 transition-all"
                  style={{ color: isMoreActive ? primaryColor : "rgba(255,255,255,0.35)" }}
                  strokeWidth={isMoreActive ? 2.5 : 1.75}
                />
              </div>
              <span
                className="text-[10px] font-medium"
                style={{ color: isMoreActive ? primaryColor : "rgba(255,255,255,0.35)" }}
              >
                More
              </span>
            </button>
          )}
        </div>
      </nav>
    </>
  );
}
