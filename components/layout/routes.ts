import type { LucideIcon } from "lucide-react";
import {
  LayoutDashboard,
  Users,
  Calendar,
  CalendarCheck,
  ClipboardCheck,
  ScanLine,
  ClipboardList,
  Award,
  TrendingUp,
  Bell,
  BarChart2,
  Tag,
  CreditCard,
  BrainCircuit,
  Settings,
} from "lucide-react";

export type StaffRole = "owner" | "manager" | "coach" | "admin";

export interface StaffNavItem {
  href: string;
  /** Full label — used by the sidebar and the mobile "More" sheet. */
  label: string;
  /** Short label for the mobile bottom tab bar; falls back to `label`. */
  mobileLabel?: string;
  icon: LucideIcon;
  roles: StaffRole[];
  /** Sidebar section grouping. */
  section: "main" | "admin";
  /** True for the four items shown as bottom tabs on mobile; the rest live in "More". */
  mobilePrimary?: boolean;
}

/**
 * The single source of truth for staff navigation. Both `Sidebar` and
 * `MobileNav` consume this list — never maintain a second copy
 * (docs/UI-RULES.md §4: one route manifest).
 */
export const STAFF_NAV: StaffNavItem[] = [
  { href: "/dashboard", label: "Dashboard", mobileLabel: "Home", icon: LayoutDashboard, roles: ["owner", "manager", "coach", "admin"], section: "main", mobilePrimary: true },
  { href: "/dashboard/coach", label: "Today's Register", icon: CalendarCheck, roles: ["owner", "manager", "coach", "admin"], section: "main" },
  // All four staff roles, matching Today's Register: the page lists only the
  // sessions /api/coach/today returns, which already narrows a coach to the
  // classes they teach, and the batch endpoint enforces the same narrowing
  // server-side. Hiding it from coaches would remove it from exactly the people
  // holding the stack of cards.
  // A bottom tab on the phone: the camera is the thing a coach reaches for
  // with a stack of cards in the other hand, and "More → Scan" is two taps
  // and a fumble. It takes the slot Mark Attendance held — which coaches never
  // had (owner/manager/admin only), so for them this is a tab gained, and for
  // the owner Mark Attendance is one tap away under More.
  { href: "/dashboard/scan", label: "Scan Cards", mobileLabel: "Scan", icon: ScanLine, roles: ["owner", "manager", "coach", "admin"], section: "main", mobilePrimary: true },
  { href: "/dashboard/timetable", label: "Timetable", mobileLabel: "Schedule", icon: Calendar, roles: ["owner", "manager", "coach", "admin"], section: "main", mobilePrimary: true },
  { href: "/dashboard/members", label: "Members", icon: Users, roles: ["owner", "manager", "coach", "admin"], section: "main", mobilePrimary: true },
  { href: "/dashboard/checkin", label: "Mark Attendance", icon: ClipboardCheck, roles: ["owner", "manager", "admin"], section: "main" },
  { href: "/dashboard/attendance", label: "Attendance", icon: ClipboardList, roles: ["owner", "manager", "coach", "admin"], section: "main" },
  { href: "/dashboard/ranks", label: "Ranks", icon: Award, roles: ["owner", "manager", "coach"], section: "admin" },
  { href: "/dashboard/promotions", label: "Promotions", icon: TrendingUp, roles: ["owner", "manager"], section: "admin" },
  { href: "/dashboard/notifications", label: "Notifications", icon: Bell, roles: ["owner", "manager"], section: "admin" },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart2, roles: ["owner", "manager"], section: "admin" },
  { href: "/dashboard/memberships", label: "Memberships", icon: Tag, roles: ["owner"], section: "admin" },
  { href: "/dashboard/payments", label: "Payments", icon: CreditCard, roles: ["owner"], section: "admin" },
  { href: "/dashboard/analysis", label: "Analysis", icon: BrainCircuit, roles: ["owner"], section: "admin" },
  { href: "/dashboard/settings", label: "Settings", icon: Settings, roles: ["owner"], section: "admin" },
];

/**
 * Active-state test shared by both navs (Sidebar and MobileNav).
 *
 * Matches on SEGMENT boundaries, not on a bare prefix: a plain
 * `pathname.startsWith(href)` lit both Members and Memberships on
 * `/dashboard/memberships`, because "/dashboard/memberships" starts with
 * "/dashboard/members". `/dashboard` itself stays an exact match, otherwise
 * it would light on every page.
 */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
