import type { CSSProperties } from "react";

/**
 * Shared admin/operator console theme — white, stylistic, modern.
 * Existing exports (adminPalette, adminPage, adminContainer, adminCard,
 * adminList, adminNavLink, adminSectionTitle, adminButtonSecondary) are
 * preserved by name with refined values, so every /admin/* page
 * automatically inherits the upgrade.
 */

// ── Palette ──────────────────────────────────────────────────────────────────

export const adminPalette = {
  // Surfaces
  page: "#f7f8fb",
  card: "#ffffff",
  cardSoft: "#f8fafc",
  glass: "rgba(255,255,255,0.72)",

  // Type
  text: "#0b1220",
  body: "#1e293b",
  muted: "#64748b",
  faint: "#94a3b8",
  ghost: "#cbd5e1",

  // Borders
  border: "#e5eaf2",
  borderSoft: "#eef2f7",
  borderStrong: "#cfd8e3",

  // Brand + semantic
  brand: "#0b1220",
  blue: "#2563eb",
  blueSoft: "#eff6ff",
  green: "#059669",
  greenSoft: "#ecfdf5",
  amber: "#d97706",
  amberSoft: "#fffbeb",
  red: "#dc2626",
  redSoft: "#fef2f2",
  violet: "#7c3aed",
  violetSoft: "#f5f3ff",
};

// ── Scale ────────────────────────────────────────────────────────────────────

export const adminSpace = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 };
export const adminRadius = { sm: 8, md: 12, lg: 16, xl: 20, pill: 999 };
export const adminShadow = {
  sm: "0 1px 2px rgba(15,23,42,0.04)",
  md: "0 1px 3px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.04)",
  lg: "0 1px 3px rgba(15,23,42,0.05), 0 12px 32px rgba(15,23,42,0.06)",
  ring: "0 0 0 4px rgba(37,99,235,0.12)",
};

// ── Layout ───────────────────────────────────────────────────────────────────

export const adminPage: CSSProperties = {
  minHeight: "100vh",
  background: adminPalette.page,
  color: adminPalette.text,
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  paddingBottom: adminSpace.xxxl,
};

export const adminContainer: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: `${adminSpace.xl}px ${adminSpace.xl}px`,
};

// ── Cards ────────────────────────────────────────────────────────────────────

export const adminCard: CSSProperties = {
  background: adminPalette.card,
  border: `1px solid ${adminPalette.border}`,
  borderRadius: adminRadius.lg,
  boxShadow: adminShadow.md,
};

export const adminCardElevated: CSSProperties = {
  ...adminCard,
  boxShadow: adminShadow.lg,
};

export const adminList: CSSProperties = {
  ...adminCard,
  overflow: "hidden",
};

// ── Typography ───────────────────────────────────────────────────────────────

export const adminPageTitle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  margin: 0,
  color: adminPalette.text,
};

export const adminPageSub: CSSProperties = {
  fontSize: 14,
  fontWeight: 500,
  color: adminPalette.muted,
  margin: `${adminSpace.xs}px 0 0`,
};

export const adminSectionTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: adminPalette.muted,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  marginBottom: adminSpace.md,
};

export const adminCardTitle: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: adminPalette.text,
  margin: 0,
  letterSpacing: "-0.01em",
};

export const adminCardDesc: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: adminPalette.muted,
  margin: `${adminSpace.xs}px 0 0`,
  lineHeight: 1.5,
};

export const adminNavLink: CSSProperties = {
  color: adminPalette.muted,
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 14,
};

// ── Buttons ──────────────────────────────────────────────────────────────────

export const adminButtonBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: adminSpace.sm,
  padding: "9px 14px",
  borderRadius: adminRadius.md,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  transition: "background-color 120ms ease, border-color 120ms ease, transform 120ms ease",
  border: `1px solid ${adminPalette.border}`,
  background: adminPalette.card,
  color: adminPalette.text,
  textDecoration: "none",
  whiteSpace: "nowrap",
};

export const adminButtonPrimary: CSSProperties = {
  ...adminButtonBase,
  background: adminPalette.brand,
  borderColor: adminPalette.brand,
  color: "#ffffff",
};

export const adminButtonSecondary: CSSProperties = adminButtonBase;

export const adminButtonGhost: CSSProperties = {
  ...adminButtonBase,
  background: "transparent",
  borderColor: "transparent",
  color: adminPalette.muted,
};

// ── Pills / badges ───────────────────────────────────────────────────────────

export function adminPill(tone: "neutral" | "blue" | "green" | "amber" | "red" | "violet"): CSSProperties {
  const tones: Record<string, { bg: string; fg: string; border: string }> = {
    neutral: { bg: adminPalette.cardSoft, fg: adminPalette.muted, border: adminPalette.border },
    blue:    { bg: adminPalette.blueSoft, fg: adminPalette.blue,   border: "#bfdbfe" },
    green:   { bg: adminPalette.greenSoft, fg: adminPalette.green, border: "#a7f3d0" },
    amber:   { bg: adminPalette.amberSoft, fg: adminPalette.amber, border: "#fcd34d" },
    red:     { bg: adminPalette.redSoft,   fg: adminPalette.red,   border: "#fecaca" },
    violet:  { bg: adminPalette.violetSoft, fg: adminPalette.violet, border: "#ddd6fe" },
  };
  const t = tones[tone];
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "3px 9px",
    borderRadius: adminRadius.pill,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.02em",
    background: t.bg,
    color: t.fg,
    border: `1px solid ${t.border}`,
    whiteSpace: "nowrap",
  };
}

// ── Stat tiles ───────────────────────────────────────────────────────────────

export const adminStatTile: CSSProperties = {
  ...adminCard,
  padding: adminSpace.lg,
  display: "flex",
  flexDirection: "column",
  gap: adminSpace.xs,
};

export const adminStatLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: adminPalette.muted,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

export const adminStatValue: CSSProperties = {
  fontSize: 28,
  fontWeight: 800,
  color: adminPalette.text,
  letterSpacing: "-0.02em",
  lineHeight: 1.05,
};

// ── Top nav (used by AdminTopNav.tsx) ────────────────────────────────────────

export const adminTopNav: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 40,
  background: adminPalette.glass,
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  borderBottom: `1px solid ${adminPalette.border}`,
};

export const adminTopNavInner: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  padding: `${adminSpace.md}px ${adminSpace.xl}px`,
  display: "flex",
  alignItems: "center",
  gap: adminSpace.xl,
};

export const adminBrandMark: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: adminRadius.md,
  background: adminPalette.brand,
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};
