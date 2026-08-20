"use client";

import { signOut } from "next-auth/react";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LogOut, ShieldOff, UserCircle } from "lucide-react";
import Image from "next/image";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { STAFF_NAV } from "@/components/layout/routes";
import { userTone } from "@/lib/color";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";

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

/* Micro-improvement pass 2026-08-17 (audit F2/F4): the per-role accent+glow
   system put five hues and banned glow shadows into the light chrome — the
   role badge is identity, not status, so it renders neutral now. */
const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  coach: "Coach",
  admin: "Admin",
  member: "Member",
};

/**
 * Page title comes from the STAFF_NAV manifest (UI-RULES §4: one route
 * manifest). This used to be a hand-maintained copy of the nav list, so a new
 * route silently rendered as "Dashboard" in the topbar. Longest matching href
 * wins, so `/dashboard/members/<id>` still reads "Members"; anything outside
 * the manifest falls back to a humanised trailing path segment.
 */
function derivePageTitle(pathname: string): string {
  const match = STAFF_NAV.filter(
    (item) => pathname === item.href || pathname.startsWith(item.href + "/"),
  ).sort((a, b) => b.href.length - a.href.length)[0];
  if (match) return match.label;

  const segment = pathname.split("/").filter(Boolean).pop();
  if (!segment) return "Dashboard";
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getRoleLabel(role: string) {
  return ROLE_LABELS[role] ?? role.charAt(0).toUpperCase() + role.slice(1);
}

export default function Topbar({ user, logoUrl, logoSize = "md" }: TopbarProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { ask, dialogProps } = useConfirmDialog();
  const roleLabel = getRoleLabel(user.role);
  const logoPadding = logoSize === "lg" ? 3 : logoSize === "sm" ? 5 : 4;
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const title = derivePageTitle(pathname);

  // §5.4: this used to be a bare native browser confirm box. It still
  // confirms — the question is now branded, keyboard-trapped, and does not
  // print the origin URL above itself the way iOS Safari does.
  async function logoutAllDevices() {
    setMenuOpen(false);
    const confirmed = await ask({
      title: "Sign out from all devices?",
      body: "You will need to sign in again on every device, including this one.",
      confirmLabel: "Sign out everywhere",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await fetch("/api/auth/logout-all", { method: "POST" });
    } catch { /* ignore */ }
    signOut({ callbackUrl: "/login" });
  }

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
        background: "var(--sf-1)",
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
            <Image src={toBlobProxyUrl(logoUrl) ?? logoUrl} alt={user.tenantName ?? "Logo"} width={36} height={36} className="w-full h-full object-contain" style={{ padding: logoPadding }} unoptimized />
          ) : (
            <span className="text-[var(--tx-on-accent)] text-xs font-bold">
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
              borderColor: menuOpen ? "var(--bd-active)" : "var(--bd-default)",
              background: "var(--sf-2)",
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Open account menu"
          >
            {/* Role badge */}
            <div className="flex items-center px-3 py-2">
              <span
                className="px-2 py-0.5 rounded-full text-[11px] font-bold"
                style={{ background: "var(--sf-1)", color: "var(--tx-2)", border: "1px solid var(--bd-default)" }}
              >
                {roleLabel}
              </span>
            </div>

            {/* Divider */}
            <div className="w-px self-stretch" style={{ background: "var(--bd-default)" }} />

            {/* Account section */}
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <div
                className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--tx-on-accent)] text-xs font-bold shrink-0"
                style={{ background: `linear-gradient(135deg, var(--color-primary), ${userTone(user.name)})` }}
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
                background: "var(--sf-1)",
                borderColor: "var(--bd-default)",
                boxShadow: "0 12px 32px rgba(0,0,0,0.14)",
              }}
            >
              <div className="p-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
                <div className="flex items-start gap-3">
                  <div
                    className="w-11 h-11 rounded-2xl flex items-center justify-center text-[var(--tx-on-accent)] text-sm font-bold shrink-0"
                    style={{ background: `linear-gradient(135deg, var(--color-primary), ${userTone(user.name)})` }}
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
                      style={{ background: "var(--sf-2)", borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                    >
                      {roleLabel}
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
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-sm transition-colors hover:bg-black/5"
                  style={{ color: "var(--tx-2)" }}
                  role="menuitem"
                >
                  <ShieldOff className="w-4 h-4" />
                  Sign out all devices
                </button>
                <button
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-sm transition-colors hover:bg-black/5"
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

      <ConfirmDialog {...dialogProps} />
    </header>
  );
}
