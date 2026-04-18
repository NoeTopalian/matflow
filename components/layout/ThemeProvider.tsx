"use client";

import { useEffect } from "react";

interface ThemeProviderProps {
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  children: React.ReactNode;
}

export default function ThemeProvider({ primaryColor, secondaryColor, textColor, children }: ThemeProviderProps) {
  useEffect(() => {
    // Also apply any locally-saved demo overrides
    const local = (() => { try { return JSON.parse(localStorage.getItem("gym-settings") ?? "{}"); } catch { return {}; } })();
    const primary   = local.primaryColor   ?? primaryColor;
    const secondary = local.secondaryColor ?? secondaryColor;
    const text      = local.textColor      ?? textColor;
    const bg        = local.bgColor        ?? null;

    const root = document.documentElement;
    root.style.setProperty("--color-primary",        primary);
    root.style.setProperty("--color-secondary",      secondary);
    root.style.setProperty("--color-text",           text);
    root.style.setProperty("--color-primary-dim",    hexToRgba(primary, 0.1));
    root.style.setProperty("--color-primary-border", hexToRgba(primary, 0.25));
    root.style.setProperty("--color-secondary-dim",  hexToRgba(secondary, 0.12));
    root.style.setProperty("--color-secondary-border", hexToRgba(secondary, 0.3));
    root.style.setProperty("--color-text-muted",     hexToRgba(text, 0.4));
    root.style.setProperty("--color-text-subtle",    hexToRgba(text, 0.2));
    // NOTE: bgColor (--sf-bg) is intentionally NOT applied here.
    // The admin dashboard always uses its own dark theme.
    // bgColor only affects the member-facing app (read in app/member/layout.tsx).
  }, [primaryColor, secondaryColor, textColor]);

  return <>{children}</>;
}

function hexToRgba(hex: string, alpha: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
