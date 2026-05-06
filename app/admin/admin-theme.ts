import type { CSSProperties } from "react";

export const adminPalette = {
  page: "#f6f8fb",
  card: "#ffffff",
  cardSoft: "#f8fafc",
  text: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  border: "#dfe6ef",
  borderSoft: "#eef2f7",
  brand: "#0f172a",
  blue: "#2563eb",
  green: "#059669",
  amber: "#d97706",
  red: "#dc2626",
};

export const adminPage: CSSProperties = {
  minHeight: "100vh",
  background: adminPalette.page,
  color: adminPalette.text,
  padding: "32px 24px",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
};

export const adminContainer: CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
};

export const adminCard: CSSProperties = {
  background: adminPalette.card,
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  boxShadow: "0 12px 30px rgba(15, 23, 42, 0.05)",
};

export const adminList: CSSProperties = {
  ...adminCard,
  overflow: "hidden",
};

export const adminNavLink: CSSProperties = {
  color: adminPalette.muted,
  textDecoration: "none",
  fontWeight: 650,
};

export const adminSectionTitle: CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  color: adminPalette.muted,
  marginBottom: 8,
  textTransform: "uppercase",
};

export const adminButtonSecondary: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  background: adminPalette.card,
  color: adminPalette.text,
  border: `1px solid ${adminPalette.border}`,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};
