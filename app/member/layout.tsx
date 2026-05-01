"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Home, Calendar, TrendingUp, User, ShoppingBag } from "lucide-react";

const TABS = [
  { href: "/member/home",     label: "Home",     icon: Home },
  { href: "/member/schedule", label: "Schedule", icon: Calendar },
  { href: "/member/progress", label: "Progress", icon: TrendingUp },
  { href: "/member/profile",  label: "Profile",  icon: User },
];

// Google Fonts import URLs for each supported font
const FONT_IMPORTS: Record<string, string> = {
  "Inter":            "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  "Montserrat":       "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap",
  "Oswald":           "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap",
  "Plus Jakarta Sans":"https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  "Barlow":           "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap",
  "Space Grotesk":    "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
  "DM Sans":          "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
  "Teko":             "https://fonts.googleapis.com/css2?family=Teko:wght@400;500;600;700&display=swap",
  "Poppins":          "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap",
  "Outfit":           "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap",
  "Raleway":          "https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700;800&display=swap",
  "Saira":            "https://fonts.googleapis.com/css2?family=Saira:wght@400;500;600;700&display=swap",
};

function extractFontName(fontFamily: string): string {
  // Extract font name from CSS value like "'Montserrat', sans-serif"
  const match = fontFamily.match(/['"]?([^'",]+)['"]?/);
  return match ? match[1].trim() : "Inter";
}

interface GymBrand {
  name: string;
  logoUrl?: string | null;
  primaryColor?: string;
  logoBg?: "none" | "black" | "white";
  bgColor?: string;
  fontFamily?: string;
}

const DEFAULT_GYM: GymBrand = {
  name: "Total BJJ",
  logoUrl: null,
  primaryColor: "#3b82f6",
  logoBg: "none",
  bgColor: "#111111",
  fontFamily: "'Inter', sans-serif",
};

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [gym, setGym] = useState<GymBrand>(DEFAULT_GYM);

  useEffect(() => {
    // Read from localStorage first (instant, works in demo mode)
    try {
      const stored = JSON.parse(localStorage.getItem("gym-settings") ?? "{}");
      if (stored.logoUrl || stored.primaryColor || stored.bgColor || stored.fontFamily) {
        setGym((prev) => ({
          ...prev,
          logoUrl:      stored.logoUrl      ?? prev.logoUrl,
          primaryColor: stored.primaryColor ?? prev.primaryColor,
          logoBg:       stored.logoBg       ?? prev.logoBg,
          bgColor:      stored.bgColor      ?? prev.bgColor,
          fontFamily:   stored.fontFamily   ?? prev.fontFamily,
        }));
      }
    } catch { /* ignore */ }

    // Then fetch fresh from API — this is the source of truth
    fetch("/api/me/gym")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data) return;
        setGym((prev) => ({
          ...prev,
          name:         data.name         ?? prev.name,
          logoUrl:      data.logoUrl      ?? prev.logoUrl,
          primaryColor: data.primaryColor ?? prev.primaryColor,
          bgColor:      data.bgColor      ?? prev.bgColor,
          fontFamily:   data.fontFamily   ?? prev.fontFamily,
        }));
        // Keep localStorage in sync with DB values
        try {
          const stored = JSON.parse(localStorage.getItem("gym-settings") ?? "{}");
          localStorage.setItem("gym-settings", JSON.stringify({ ...stored, ...data }));
        } catch { /* ignore */ }
      })
      .catch(() => { /* offline / demo */ });

    // Listen for branding changes saved from admin (same browser tab or cross-tab)
    function onStorage(e: StorageEvent) {
      if (e.key !== "gym-settings" || !e.newValue) return;
      try {
        const updated = JSON.parse(e.newValue);
        setGym((prev) => ({
          ...prev,
          logoUrl:      updated.logoUrl      ?? prev.logoUrl,
          primaryColor: updated.primaryColor ?? prev.primaryColor,
          logoBg:       updated.logoBg       ?? prev.logoBg,
          bgColor:      updated.bgColor      ?? prev.bgColor,
          fontFamily:   updated.fontFamily   ?? prev.fontFamily,
        }));
      } catch { /* ignore */ }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Dynamically inject Google Fonts when font changes
  useEffect(() => {
    if (!gym.fontFamily) return;
    const fontName = extractFontName(gym.fontFamily);
    const url = FONT_IMPORTS[fontName];
    if (!url) return;
    const id = `gfont-${fontName.replace(/\s/g, "-").toLowerCase()}`;
    if (!document.getElementById(id)) {
      const link = document.createElement("link");
      link.id = id;
      link.rel = "stylesheet";
      link.href = url;
      document.head.appendChild(link);
    }
  }, [gym.fontFamily]);

  // Validators to prevent CSS injection via tenant-controlled branding values.
  const isHexColor = (s: unknown): s is string =>
    typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s);

  const isSafeFontFamily = (s: unknown): s is string =>
    typeof s === "string" && /^[A-Za-z0-9 ,'"_-]+$/.test(s) && s.length < 100;

  const primary  = isHexColor(gym.primaryColor) ? gym.primaryColor : "#3b82f6";
  const appBg    = isHexColor(gym.bgColor)       ? gym.bgColor      : "#111111";
  const appFont  = isSafeFontFamily(gym.fontFamily) ? gym.fontFamily : "'Inter', sans-serif";

  // Detect light mode: bg is light if it starts with #f, #e, or is white
  const bgInt = parseInt((appBg.replace("#", "") + "000000").slice(0, 6), 16);
  const bgR = (bgInt >> 16) & 255;
  const bgG = (bgInt >> 8) & 255;
  const bgB = bgInt & 255;
  const bgLuma = (bgR * 299 + bgG * 587 + bgB * 114) / 1000;
  const isLight = bgLuma > 160;

  const navBg      = isLight ? `${appBg}f5`            : "rgba(10,11,14,0.97)";
  const navBorder  = isLight ? "rgba(0,0,0,0.08)"      : "rgba(255,255,255,0.07)";
  const inactiveCol= isLight ? "rgba(0,0,0,0.35)"      : "rgba(255,255,255,0.3)";
  const textMain   = isLight ? "#0f172a"                : "#ffffff";
  const textMuted  = isLight ? "#64748b"                : "rgba(255,255,255,0.45)";
  const surfaceBg  = isLight ? "rgba(0,0,0,0.04)"      : "rgba(255,255,255,0.04)";
  const surfaceBorder = isLight ? "rgba(0,0,0,0.08)"   : "rgba(255,255,255,0.07)";

  // Light-mode CSS overrides injected as a style tag so child pages (home, schedule, etc.) adapt
  const lightModeCSS = isLight ? `
    #member-app .text-white { color: ${textMain} !important; }
    #member-app .text-gray-100, #member-app .text-gray-200 { color: #1e293b !important; }
    #member-app .text-gray-300 { color: #374151 !important; }
    #member-app .text-gray-400 { color: #4b5563 !important; }
    #member-app .text-gray-500 { color: #64748b !important; }
    #member-app .text-gray-600 { color: #94a3b8 !important; }
    #member-app .text-gray-700 { color: #cbd5e1 !important; }
    #member-app .border-white\\/5  { border-color: rgba(0,0,0,0.05)  !important; }
    #member-app .border-white\\/8  { border-color: rgba(0,0,0,0.08)  !important; }
    #member-app .border-white\\/10 { border-color: rgba(0,0,0,0.10) !important; }
    #member-app .border-white\\/\\[0\\.08\\] { border-color: rgba(0,0,0,0.08) !important; }
    #member-app .bg-white\\/5  { background: rgba(0,0,0,0.05)  !important; }
    #member-app .bg-white\\/8  { background: rgba(0,0,0,0.08)  !important; }
    #member-app .bg-white\\/10 { background: rgba(0,0,0,0.10) !important; }
    #member-app .bg-white\\/15 { background: rgba(0,0,0,0.12) !important; }
    #member-app .hover\\:text-white:hover { color: #0f172a !important; }
  ` : "";

  function isActive(href: string) {
    return pathname.startsWith(href);
  }

  return (
    <div
      id="member-app"
      className="flex flex-col min-h-screen"
      style={{
        background: appBg,
        fontFamily: appFont,
        // CSS vars used by child pages for theme-aware colors
        ["--member-text" as string]: textMain,
        ["--member-text-muted" as string]: textMuted,
        ["--member-surface" as string]: surfaceBg,
        ["--member-border" as string]: surfaceBorder,
        ["--member-text-dim" as string]: isLight ? "rgba(0,0,0,0.3)" : "rgba(255,255,255,0.2)",
        ["--member-hr" as string]: isLight ? "rgba(0,0,0,0.07)" : "rgba(255,255,255,0.05)",
        ["--member-inactive" as string]: isLight ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.35)",
        ["--member-elevated" as string]: isLight ? "#f8fafc" : "#0e1013",
        ["--member-elevated-border" as string]: isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.08)",
      }}
    >
      {lightModeCSS && <style dangerouslySetInnerHTML={{ __html: lightModeCSS }} />}
      {/* ── Top bar ── */}
      <header
        className="shrink-0 z-20"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 14px)",
          paddingBottom: 14,
          background: `${appBg}ee`,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: `1px solid ${isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)"}`,
        }}
      >
        {/* 3-column grid keeps the logo dead-centre against the screen.
            Without it the Shop bubble eats the right side and the logo
            visually drifts left on mobile (≈18px on a 375px viewport). */}
        <div className="grid grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-2 px-4">
          {/* Left spacer — same width as the Shop bubble so the centre column is symmetric */}
          <div />
          {/* Centred gym brand */}
          <div className="flex items-center justify-center min-w-0">
          {gym.logoUrl ? (
            <div
              className="rounded-lg px-2 flex items-center justify-center max-w-full"
              style={{
                background: gym.logoBg === "black" ? "#000" : gym.logoBg === "white" ? "#fff" : "transparent",
              }}
            >
              {gym.logoUrl.startsWith("data:") || gym.logoUrl.startsWith("/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={gym.logoUrl}
                  alt={gym.name}
                  style={{ height: 44, maxWidth: "100%", width: "auto", objectFit: "contain" }}
                />
              ) : (
                <Image
                  src={gym.logoUrl}
                  alt={gym.name}
                  width={160}
                  height={44}
                  className="object-contain max-w-full h-auto"
                  style={{ maxHeight: 44 }}
                />
              )}
            </div>
          ) : (
            <span
              className="font-bold text-xl tracking-tight leading-none truncate text-center"
              style={{ color: isLight ? "#0f172a" : "#ffffff" }}
            >
              {gym.name}
            </span>
          )}
          </div>
          {/* Shop bubble — pinned right */}
          <Link
            href="/member/shop"
            className="w-9 h-9 rounded-full flex items-center justify-center transition-all active:scale-90"
            style={{
              background: isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)",
              border: `1px solid ${isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)"}`,
            }}
            aria-label="Shop"
          >
            <ShoppingBag
              className="w-4 h-4"
              style={{ color: isLight ? "#374151" : "rgba(255,255,255,0.7)" }}
            />
          </Link>
        </div>
      </header>

      {/* ── Content ── */}
      <main className="flex-1 overflow-y-auto pb-28">
        {children}
      </main>

      {/* ── Bottom tab bar ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around"
        style={{
          background: navBg,
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderTop: `1px solid ${navBorder}`,
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingTop: 8,
          paddingLeft: 8,
          paddingRight: 8,
        }}
        aria-label="Member navigation"
      >
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex flex-col items-center gap-1 min-w-[56px] py-1 transition-transform active:scale-90"
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
            >
              <div className="w-7 h-7 flex items-center justify-center">
                <tab.icon
                  className="w-5 h-5 transition-all"
                  style={{
                    color: active ? primary : inactiveCol,
                    strokeWidth: active ? 2.5 : 1.75,
                  }}
                />
              </div>
              <span
                className="text-[10px] font-medium transition-colors"
                style={{ color: active ? primary : inactiveCol }}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
