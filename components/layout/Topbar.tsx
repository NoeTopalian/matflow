"use client";

import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, ShieldOff, UserCircle } from "lucide-react";
import Image from "next/image";

async function logoutAllDevices() {
  if (!confirm("Sign out from all devices? You will need to sign in again on every device.")) return;
  try {
    await fetch("/api/auth/logout-all", { method: "POST" });
  } catch { /* ignore */ }
  signOut({ callbackUrl: "/login" });
}

interface TopbarProps {
  user: {
    name: string;
    email: string;
    role: string;
    primaryColor?: string;
    tenantName?: string;
  };
  logoUrl?: string;
  logoSize?: "sm" | "md" | "lg";
}

const roleMeta: Record<string, { label: string; accent: string; soft: string; border: string; glow: string }> = {
  owner: {
    label: "Owner",
    accent: "#f59e0b",
    soft: "rgba(245,158,11,0.14)",
    border: "rgba(245,158,11,0.34)",
    glow: "0 0 24px rgba(245,158,11,0.20)",
  },
  manager: {
    label: "Manager",
    accent: "#a78bfa",
    soft: "rgba(167,139,250,0.14)",
    border: "rgba(167,139,250,0.32)",
    glow: "0 0 24px rgba(167,139,250,0.18)",
  },
  coach: {
    label: "Coach",
    accent: "#38bdf8",
    soft: "rgba(56,189,248,0.14)",
    border: "rgba(56,189,248,0.30)",
    glow: "0 0 24px rgba(56,189,248,0.16)",
  },
  admin: {
    label: "Admin",
    accent: "#34d399",
    soft: "rgba(52,211,153,0.14)",
    border: "rgba(52,211,153,0.30)",
    glow: "0 0 24px rgba(52,211,153,0.16)",
  },
  member: {
    label: "Member",
    accent: "#60a5fa",
    soft: "rgba(96,165,250,0.12)",
    border: "rgba(96,165,250,0.26)",
    glow: "0 0 20px rgba(96,165,250,0.12)",
  },
};

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/members": "Members",
  "/dashboard/timetable": "Timetable",
  "/dashboard/attendance": "Attendance",
  "/dashboard/checkin": "Mark Attendance",
  "/dashboard/ranks": "Ranks",
  "/dashboard/notifications": "Notifications",
  "/dashboard/reports": "Reports",
  "/dashboard/analysis": "Analysis",
  "/dashboard/settings": "Settings",
};

function getRoleMeta(role: string) {
  return roleMeta[role] ?? {
    label: role.charAt(0).toUpperCase() + role.slice(1),
    accent: "#94a3b8",
    soft: "rgba(148,163,184,0.12)",
    border: "rgba(148,163,184,0.25)",
    glow: "0 0 20px rgba(148,163,184,0.12)",
  };
}

export default function Topbar({ user, logoUrl, logoSize = "md" }: TopbarProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const role = getRoleMeta(user.role);
  const logoPadding = logoSize === "lg" ? 3 : logoSize === "sm" ? 5 : 4;
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const title =
    Object.entries(pageTitles)
      .filter(([path]) => pathname === path || pathname.startsWith(path + "/"))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "Dashboard";

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <header
      className="h-16 flex items-center justify-between px-6 shrink-0 border-b relative z-10"
      style={{
        background: "linear-gradient(180deg, rgba(14,16,20,0.96), rgba(10,11,14,0.92))",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        borderColor: "var(--bd-default)",
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="shrink-0 rounded-xl overflow-hidden flex items-center justify-center"
          style={{
            width: 36, height: 36,
            ...(!logoUrl ? { background: "var(--color-primary)" } : {}),
          }}
        >
          {logoUrl ? (
            <Image src={logoUrl} alt={user.tenantName ?? "Logo"} width={36} height={36} className="w-full h-full object-contain" style={{ padding: logoPadding }} unoptimized />
          ) : (
            <span className="text-white text-xs font-bold">
              {(user.tenantName ?? "M").charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "var(--tx-4)" }}>
            Back Office
          </p>
          <h1 className="text-[15px] font-semibold tracking-tight leading-tight truncate" style={{ color: "var(--tx-1)" }}>
            {title}
          </h1>
        </div>
      </div>

      <div className="flex items-center">
        <div className="relative" ref={menuRef}>
          {/* Single unified pill: role badge + account */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center rounded-2xl border transition-all hover:brightness-110 overflow-hidden"
            style={{
              borderColor: menuOpen ? role.border : "rgba(255,255,255,0.09)",
              background: menuOpen ? `linear-gradient(135deg, ${role.soft}, rgba(255,255,255,0.04))` : "rgba(255,255,255,0.04)",
              boxShadow: menuOpen ? role.glow : "none",
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Open account menu"
          >
            {/* Role badge */}
            <div className="flex items-center px-3 py-2">
              <span
                className="px-2 py-0.5 rounded-full text-[11px] font-bold"
                style={{ background: role.soft, color: role.accent, border: `1px solid ${role.border}` }}
              >
                {role.label}
              </span>
            </div>

            {/* Divider */}
            <div className="w-px self-stretch" style={{ background: "rgba(255,255,255,0.08)" }} />

            {/* Account section */}
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0"
                style={{
                  background: "linear-gradient(135deg, var(--color-primary), rgba(255,255,255,0.16))",
                  boxShadow: "0 4px 14px var(--color-primary-dim)",
                }}
              >
                {initials}
              </div>
              <span className="hidden lg:block text-sm font-semibold max-w-[120px] truncate" style={{ color: "var(--tx-1)" }}>
                {user.name.split(" ")[0] ?? "Account"}
              </span>
              <ChevronDown
                className={`w-3.5 h-3.5 transition-transform ${menuOpen ? "rotate-180" : ""}`}
                style={{ color: "var(--tx-3)" }}
              />
            </div>
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-[calc(100%+10px)] w-72 rounded-2xl border shadow-xl overflow-hidden z-50"
              style={{
                background: "linear-gradient(180deg, var(--sf-1), var(--sf-0))",
                borderColor: "var(--bd-default)",
                boxShadow: "0 24px 60px rgba(0,0,0,0.56)",
              }}
            >
              <div className="p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
                <div className="flex items-start gap-3">
                  <div
                    className="w-11 h-11 rounded-2xl flex items-center justify-center text-white text-sm font-bold shrink-0"
                    style={{
                      background: "linear-gradient(135deg, var(--color-primary), rgba(255,255,255,0.16))",
                      boxShadow: "0 10px 26px var(--color-primary-dim)",
                    }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                      {user.name}
                    </p>
                    <p className="text-xs truncate mt-0.5" style={{ color: "var(--tx-3)" }}>
                      {user.email}
                    </p>
                    <div
                      className="inline-flex items-center gap-1.5 mt-2 rounded-full border px-2 py-1 text-[11px] font-bold"
                      style={{ background: role.soft, borderColor: role.border, color: role.accent }}
                    >
                      {role.label}
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-2">
                <div className="px-2 py-2 flex items-center gap-2 text-xs" style={{ color: "var(--tx-3)" }}>
                  <UserCircle className="w-4 h-4" />
                  <span className="truncate">Signed in to {user.tenantName ?? "MatFlow"}</span>
                </div>
                <button
                  onClick={logoutAllDevices}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-sm transition-colors hover:bg-white/5"
                  style={{ color: "var(--tx-2)" }}
                  role="menuitem"
                >
                  <ShieldOff className="w-4 h-4" />
                  Sign out all devices
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-sm transition-colors hover:bg-white/5"
                  style={{ color: "var(--tx-2)" }}
                  role="menuitem"
                >
                  <LogOut className="w-4 h-4" />
                  Sign out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
