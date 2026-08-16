"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { MoreHorizontal, LogOut, X } from "lucide-react";
import { STAFF_NAV, isNavActive, type StaffRole } from "@/components/layout/routes";

interface Props {
  role: string;
  primaryColor: string;
}

// Staff mobile nav — consumes the single STAFF_NAV manifest (docs/UI-RULES.md
// §4: one route list shared with Sidebar; a route added there appears here).
// Light staff shell (§1): surfaces/text come from the --sf/--tx/--bd tokens —
// this file previously hardcoded the pre-migration dark palette.
export default function MobileNav({ role, primaryColor }: Props) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  // Audit R9: normalise like Sidebar (H13) — a role of "Owner" previously
  // produced a completely empty bottom nav while the desktop sidebar worked.
  const normalizedRole = (role ?? "").toLowerCase().trim() as StaffRole;
  const visible = STAFF_NAV.filter((i) => i.roles.includes(normalizedRole));
  const visiblePrimary = visible.filter((i) => i.mobilePrimary);
  const visibleMore = visible.filter((i) => !i.mobilePrimary);
  const isMoreActive = visibleMore.some((i) => isNavActive(i.href, pathname));

  return (
    <>
      {/* Backdrop */}
      {moreOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40 md:hidden"
          onClick={() => setMoreOpen(false)}
        />
      )}

      {/* More sheet */}
      <div
        className={`fixed bottom-0 left-0 right-0 z-50 md:hidden transition-transform duration-300 ease-out ${
          moreOpen ? "translate-y-0" : "translate-y-full"
        }`}
        style={{
          background: "var(--sf-1)",
          borderTop: "1px solid var(--bd-default)",
          borderRadius: "20px 20px 0 0",
          boxShadow: "0 -8px 32px rgba(12,14,20,0.12)",
        }}
      >
        <div
          className="flex justify-between items-center px-5 py-4"
          style={{ borderBottom: "1px solid var(--bd-default)" }}
        >
          <p className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>More</p>
          <button
            onClick={() => setMoreOpen(false)}
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: "var(--sf-2)" }}
            aria-label="Close menu"
          >
            <X className="w-4 h-4" style={{ color: "var(--tx-2)" }} />
          </button>
        </div>
        <div className="px-4 py-3 space-y-1 pb-safe">
          {visibleMore.map((item) => {
            const active = isNavActive(item.href, pathname);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMoreOpen(false)}
                className="flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all active:scale-[0.98]"
                style={{
                  background: active ? `${primaryColor}15` : "transparent",
                  color: active ? primaryColor : "var(--tx-2)",
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
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all active:scale-[0.98]"
            style={{ color: "var(--hue-danger)" }}
            aria-label="Sign out"
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span className="text-sm font-medium">Sign out</span>
          </button>
          {/* Audit M1: session revocation was desktop-only (Topbar) — a staff
              member who loses their phone must be able to revoke from mobile. */}
          <button
            onClick={async () => {
              if (revoking) return;
              setRevoking(true);
              try {
                await fetch("/api/auth/logout-all", { method: "POST" });
              } catch {
                /* proceed to sign-out regardless — local session still ends */
              }
              void signOut({ callbackUrl: "/login" });
            }}
            className="w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl transition-all active:scale-[0.98] disabled:opacity-60"
            style={{ color: "var(--tx-2)" }}
            aria-label="Sign out all devices"
            disabled={revoking}
          >
            <LogOut className="w-5 h-5 shrink-0" />
            <span className="text-sm font-medium">{revoking ? "Signing out everywhere…" : "Sign out all devices"}</span>
          </button>
        </div>
        {/* Safe area padding */}
        <div className="h-6" />
      </div>

      {/* Bottom tab bar */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 md:hidden flex items-end"
        style={{
          background: "color-mix(in srgb, var(--sf-1) 92%, transparent)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: "1px solid var(--bd-default)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-around w-full px-2 pt-2 pb-1">
          {visiblePrimary.map((item) => {
            const active = isNavActive(item.href, pathname);
            const label = item.mobileLabel ?? item.label;
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
                    <item.icon className="w-6 h-6" style={{ color: "var(--tx-on-accent)" }} />
                  </div>
                  <span className="text-[10px] font-medium" style={{ color: active ? primaryColor : "var(--tx-3)" }}>
                    {label}
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
                    style={{ color: active ? primaryColor : "var(--tx-3)" }}
                    strokeWidth={active ? 2.5 : 1.75}
                  />
                </div>
                <span
                  className="text-[10px] font-medium transition-colors"
                  style={{ color: active ? primaryColor : "var(--tx-3)" }}
                >
                  {label}
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
                  style={{ color: isMoreActive ? primaryColor : "var(--tx-3)" }}
                  strokeWidth={isMoreActive ? 2.5 : 1.75}
                />
              </div>
              <span
                className="text-[10px] font-medium"
                style={{ color: isMoreActive ? primaryColor : "var(--tx-3)" }}
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
