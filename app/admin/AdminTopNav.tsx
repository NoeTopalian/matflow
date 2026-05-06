"use client";

/**
 * Sticky operator-console top nav with frosted-glass backdrop.
 * Reusable across all /admin/* pages. Reads operator identity if known
 * (passed in via props since the parent server component has the context).
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LayoutDashboard, Building2, Inbox, CreditCard, Activity, ShieldCheck, LogOut, ShieldHalf } from "lucide-react";
import {
  adminBrandMark,
  adminPalette,
  adminTopNav,
  adminTopNavInner,
  adminButtonGhost,
  adminRadius,
  adminSpace,
} from "./admin-theme";

const NAV_ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/tenants", label: "Tenants", icon: Building2 },
  { href: "/admin/applications", label: "Applications", icon: Inbox },
  { href: "/admin/billing", label: "Billing", icon: CreditCard },
  { href: "/admin/activity", label: "Activity", icon: Activity },
  { href: "/admin/security", label: "Security", icon: ShieldCheck },
] as const;

export default function AdminTopNav({ operatorEmail }: { operatorEmail?: string | null }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    try {
      await fetch("/api/admin/auth/logout", { method: "POST" });
    } catch {
      /* swallow — we redirect regardless */
    }
    router.push("/admin/login");
  }

  return (
    <nav style={adminTopNav}>
      <div style={adminTopNavInner}>
        <Link href="/admin" style={{ display: "inline-flex", alignItems: "center", gap: adminSpace.sm, textDecoration: "none" }}>
          <span style={adminBrandMark}>
            <ShieldHalf size={16} aria-hidden />
          </span>
          <span style={{ fontWeight: 800, fontSize: 14, color: adminPalette.text, letterSpacing: "-0.01em" }}>
            MatFlow <span style={{ color: adminPalette.muted, fontWeight: 600 }}>operator</span>
          </span>
        </Link>

        <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, marginLeft: adminSpace.md }}>
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 11px",
                  borderRadius: adminRadius.md,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: "none",
                  color: active ? adminPalette.text : adminPalette.muted,
                  background: active ? adminPalette.cardSoft : "transparent",
                  border: `1px solid ${active ? adminPalette.border : "transparent"}`,
                }}
              >
                <Icon size={14} aria-hidden />
                {label}
              </Link>
            );
          })}
        </div>

        {operatorEmail ? (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: adminSpace.sm,
              padding: "5px 10px",
              borderRadius: adminRadius.pill,
              border: `1px solid ${adminPalette.border}`,
              background: adminPalette.cardSoft,
              fontSize: 12,
              fontWeight: 600,
              color: adminPalette.text,
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={operatorEmail}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: adminPalette.green,
                flexShrink: 0,
              }}
              aria-hidden
            />
            {operatorEmail}
          </div>
        ) : null}

        <button type="button" onClick={logout} style={adminButtonGhost} aria-label="Sign out">
          <LogOut size={14} aria-hidden />
          Sign out
        </button>
      </div>
    </nav>
  );
}
