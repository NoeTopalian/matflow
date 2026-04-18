"use client";

import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";

interface TopbarProps {
  user: {
    name: string;
    email: string;
    role: string;
  };
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
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Match longest prefix to handle dynamic routes like /dashboard/members/[id]
  const title =
    Object.entries(pageTitles)
      .filter(([path]) => pathname === path || pathname.startsWith(path + "/"))
      .sort((a, b) => b[0].length - a[0].length)[0]?.[1] ?? "Dashboard";

  return (
    <header
      className="h-14 flex items-center justify-between px-6 shrink-0 border-b"
      style={{
        background: "rgba(7,9,14,0.8)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        borderColor: "var(--bd-default)",
      }}
    >
      {/* Page title */}
      <h1
        className="text-base font-semibold tracking-tight"
        style={{ color: "var(--tx-1)" }}
      >
        {title}
      </h1>

      {/* Right: user + signout */}
      <div className="flex items-center gap-2">
        {/* Role badge */}
        <span
          className="hidden sm:inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-semibold"
          style={{
            background: roleBadgeColor[user.role] ?? "rgba(255,255,255,0.08)",
            color: roleTextColor[user.role] ?? "var(--tx-2)",
          }}
        >
          {roleLabel[user.role] ?? user.role}
        </span>

        {/* Avatar + name */}
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
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors hover:bg-white/8"
          title="Sign out"
          style={{ color: "var(--tx-3)" }}
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
