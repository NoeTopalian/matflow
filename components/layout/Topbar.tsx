"use client";

import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, ShieldCheck, ShieldOff, UserCircle } from "lucide-react";

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

const roleLabel: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  coach: "Coach",
  admin: "Admin",
};

const roleBadgeColor: Record<string, string> = {
  owner:   "rgba(245,158,11,0.15)",
  manager: "rgba(139,92,246,0.15)",
  coach:   "rgba(59,130,246,0.15)",
  admin:   "rgba(16,185,129,0.15)",
};

const roleTextColor: Record<string, string> = {
  owner:   "#f59e0b",
  manager: "#8b5cf6",
  coach:   "#3b82f6",
  admin:   "#10b981",
};

const pageTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/dashboard/members": "Members",
  "/dashboard/timetable": "Timetable",
  "/dashboard/attendance": "Attendance",
  "/dashboard/checkin": "Check-In",
  "/dashboard/ranks": "Ranks",
  "/dashboard/notifications": "Notifications",
  "/dashboard/reports": "Reports",
  "/dashboard/analysis": "Analysis",
  "/dashboard/settings": "Settings",
};

export default function Topbar({ user }: TopbarProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
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
      className="h-14 flex items-center justify-between px-5 shrink-0 border-b"
      style={{
        background: "rgba(10,11,14,0.92)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderColor: "var(--bd-default)",
      }}
    >
      {/* Left: page title. Workspace identity lives in the sidebar. */}
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-sm font-semibold tracking-tight" style={{ color: "var(--tx-1)" }}>
            {title}
          </h1>
          {user.tenantName && (
            <p className="text-[11px] leading-tight hidden lg:block" style={{ color: "var(--tx-3)" }}>
              {user.tenantName}
            </p>
          )}
        </div>
      </div>

      {/* Right: operational badges + compact account menu */}
      <div className="flex items-center gap-2">
        <span
          className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold"
          style={{
            background: roleBadgeColor[user.role] ?? "rgba(0,0,0,0.06)",
            color: roleTextColor[user.role] ?? "var(--tx-2)",
          }}
        >
          {roleLabel[user.role] ?? user.role}
        </span>

        {user.role === "owner" && (
          <span
            className="hidden lg:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold"
            style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}
            title="Owner security controls are available in Account settings"
          >
            <ShieldCheck className="w-3 h-3" />
            Security
          </span>
        )}

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-xl border transition-colors hover:bg-white/5"
            style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.03)" }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
              style={{ background: "var(--color-primary)" }}
            >
              {initials}
            </div>
            <span className="hidden md:block text-sm font-medium" style={{ color: "var(--tx-2)" }}>
              {user.name}
            </span>
            <ChevronDown className="w-3.5 h-3.5 hidden sm:block" style={{ color: "var(--tx-3)" }} />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-[calc(100%+8px)] w-64 rounded-2xl border shadow-xl overflow-hidden z-50"
              style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", boxShadow: "0 18px 40px rgba(0,0,0,0.5)" }}
            >
              <div className="px-4 py-3 border-b" style={{ borderColor: "var(--bd-default)" }}>
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-xs font-bold shrink-0"
                    style={{ background: "var(--color-primary)" }}
                  >
                    {initials}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>{user.name}</p>
                    <p className="text-xs truncate" style={{ color: "var(--tx-3)" }}>{user.email}</p>
                  </div>
                </div>
              </div>

              <div className="p-2">
                <div className="px-2 py-2 flex items-center gap-2 text-xs" style={{ color: "var(--tx-3)" }}>
                  <UserCircle className="w-4 h-4" />
                  <span className="truncate">{roleLabel[user.role] ?? user.role} at {user.tenantName ?? "MatFlow"}</span>
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
