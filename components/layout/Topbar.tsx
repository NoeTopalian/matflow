"use client";

import Image from "next/image";
import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { LogOut, ShieldOff } from "lucide-react";

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

const LOGO_PX: Record<string, number> = { sm: 24, md: 28, lg: 36 };

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

export default function Topbar({ user, logoUrl, logoSize = "md" }: TopbarProps) {
  const pathname = usePathname();
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const logoPx = LOGO_PX[logoSize] ?? 28;

  const title =
    Object.entries(pageTitles)
      .filter(([path]) => pathname === path || pathname.startsWith(path + "/"))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "Dashboard";

  return (
    <header
      className="h-14 flex items-center justify-between px-5 shrink-0 border-b"
      style={{
        background: "rgba(248,250,252,0.92)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderColor: "var(--bd-default)",
      }}
    >
      {/* Left: logo + page title */}
      <div className="flex items-center gap-3">
        {/* Club logo */}
        <div
          className="rounded-lg overflow-hidden flex items-center justify-center shrink-0"
          style={{
            width: logoPx,
            height: logoPx,
            ...(!logoUrl ? { background: "var(--color-primary)" } : {}),
          }}
        >
          {logoUrl ? (
            <Image
              src={logoUrl}
              alt={user.tenantName ?? ""}
              width={logoPx}
              height={logoPx}
              className="w-full h-full object-cover"
              unoptimized
            />
          ) : (
            <span className="text-white font-bold text-xs">
              {(user.tenantName ?? "M").charAt(0).toUpperCase()}
            </span>
          )}
        </div>

        <div className="w-px h-5" style={{ background: "var(--bd-default)" }} />

        <h1
          className="text-sm font-semibold tracking-tight"
          style={{ color: "var(--tx-1)" }}
        >
          {title}
        </h1>
      </div>

      {/* Right: role badge + user + signout */}
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

        <div className="flex items-center gap-2 pl-1">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0"
            style={{ background: "var(--color-primary)" }}
          >
            {initials}
          </div>
          <span className="hidden md:block text-sm font-medium" style={{ color: "var(--tx-2)" }}>
            {user.name}
          </span>
        </div>

        <div className="w-px h-5 mx-1" style={{ background: "var(--bd-hover)" }} />

        <button
          onClick={logoutAllDevices}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-black/5"
          title="Sign out of all devices"
          style={{ color: "var(--tx-3)" }}
        >
          <ShieldOff className="w-4 h-4" />
        </button>
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-black/5"
          title="Sign out"
          style={{ color: "var(--tx-3)" }}
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
