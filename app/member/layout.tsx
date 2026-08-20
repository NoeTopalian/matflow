"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Home, Calendar, TrendingUp, User, ShoppingBag } from "lucide-react";
import Recommend2FABannerMember from "@/components/layout/Recommend2FABannerMember";
import { readableOn } from "@/lib/color";
import { toBlobProxyUrl } from "@/lib/blob-url";

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

// Neutral pre-fetch shell — the name stays empty until /api/me/gym (or
// localStorage) supplies the real gym. Seeding a specific gym's identity here
// used to flash "Total BJJ" on every tenant's cold start (UI-RULES §7).
const DEFAULT_GYM: GymBrand = {
  name: "",
  logoUrl: null,
  primaryColor: "#3b82f6",
  logoBg: "none",
  bgColor: "#111111",
  fontFamily: "'Inter', sans-serif",
};

// Whatever a branding source (cached localStorage blob, /api/me/gym payload)
// actually supplies. Both are parsed JSON, i.e. `unknown` at the boundary —
// `toBrandPatch` narrows field by field and drops anything of the wrong type.
type BrandPatch = Partial<GymBrand>;

const EMPTY_PATCH: BrandPatch = {};
const GYM_SETTINGS_KEY = "gym-settings";

function toBrandPatch(raw: unknown): BrandPatch {
  if (typeof raw !== "object" || raw === null) return EMPTY_PATCH;
  const o = raw as Record<string, unknown>;
  const patch: BrandPatch = {};
  if (typeof o.name === "string") patch.name = o.name;
  if (typeof o.logoUrl === "string") patch.logoUrl = o.logoUrl;
  if (typeof o.primaryColor === "string") patch.primaryColor = o.primaryColor;
  if (o.logoBg === "none" || o.logoBg === "black" || o.logoBg === "white") patch.logoBg = o.logoBg;
  if (typeof o.bgColor === "string") patch.bgColor = o.bgColor;
  if (typeof o.fontFamily === "string") patch.fontFamily = o.fontFamily;
  return patch;
}

// localStorage is an external store, so it is read through
// useSyncExternalStore rather than copied into state from an effect. The
// snapshot is memoised against the raw string so repeated renders get a
// referentially stable object (a fresh JSON.parse each call would loop).
let snapshotRaw: string | null = null;
let snapshotPatch: BrandPatch = EMPTY_PATCH;

function readStoredBrand(): BrandPatch {
  let raw: string | null = null;
  try { raw = localStorage.getItem(GYM_SETTINGS_KEY); } catch { /* private mode */ }
  if (raw === snapshotRaw) return snapshotPatch;
  snapshotRaw = raw;
  try { snapshotPatch = raw ? toBrandPatch(JSON.parse(raw)) : EMPTY_PATCH; }
  catch { snapshotPatch = EMPTY_PATCH; }
  return snapshotPatch;
}

// No localStorage during SSR — the server always renders the neutral shell.
function readStoredBrandOnServer(): BrandPatch {
  return EMPTY_PATCH;
}

// Branding changes saved from admin (same browser tab or cross-tab).
function subscribeToStoredBrand(onChange: () => void): () => void {
  function onStorage(e: StorageEvent) {
    if (e.key !== GYM_SETTINGS_KEY || !e.newValue) return;
    onChange();
  }
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export default function MemberLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // Cached branding — instant, works in demo mode.
  const storedBrand = useSyncExternalStore(
    subscribeToStoredBrand,
    readStoredBrand,
    readStoredBrandOnServer,
  );
  // Fresh branding from the API — the source of truth, so it wins.
  const [apiBrand, setApiBrand] = useState<BrandPatch>(EMPTY_PATCH);

  useEffect(() => {
    fetch("/api/me/gym")
      .then((r) => r.ok ? r.json() : null)
      .then((data: unknown) => {
        if (!data) return;
        setApiBrand(toBrandPatch(data));
        // Keep localStorage in sync with DB values
        try {
          const raw = localStorage.getItem(GYM_SETTINGS_KEY);
          const parsed: unknown = raw ? JSON.parse(raw) : {};
          const stored = typeof parsed === "object" && parsed !== null ? parsed : {};
          localStorage.setItem(GYM_SETTINGS_KEY, JSON.stringify({ ...stored, ...toBrandPatch(data) }));
        } catch { /* ignore */ }
      })
      .catch(() => { /* offline / demo */ });
  }, []);

  // Derived during render — no state copy, no effect. The cached blob never
  // supplies `name`: a stale name would flash another tenant's identity on a
  // shared browser (UI-RULES §7), so only the API sets it. `logoBg` is
  // admin-local and is not returned by /api/me/gym.
  const gym: GymBrand = {
    name:         apiBrand.name         ?? DEFAULT_GYM.name,
    logoUrl:      apiBrand.logoUrl      ?? storedBrand.logoUrl      ?? DEFAULT_GYM.logoUrl,
    primaryColor: apiBrand.primaryColor ?? storedBrand.primaryColor ?? DEFAULT_GYM.primaryColor,
    logoBg:       storedBrand.logoBg    ?? DEFAULT_GYM.logoBg,
    bgColor:      apiBrand.bgColor      ?? storedBrand.bgColor      ?? DEFAULT_GYM.bgColor,
    fontFamily:   apiBrand.fontFamily   ?? storedBrand.fontFamily   ?? DEFAULT_GYM.fontFamily,
  };

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

  // Branding uploads land in Vercel Blob with access: "private", so the raw
  // URL is not fetchable by a browser — it has to go through the
  // authenticated proxy or the header renders as blank space.
  const logoSrc = gym.logoUrl ? toBlobProxyUrl(gym.logoUrl) ?? gym.logoUrl : "";

  // Light-mode CSS overrides injected as a style tag so child pages (home, schedule, etc.) adapt
  const lightModeCSS = isLight ? `
    #member-app .text-white { color: ${textMain} !important; }
    #member-app .text-gray-100, #member-app .text-gray-200 { color: #1e293b !important; }
    #member-app .text-gray-300 { color: #374151 !important; }
    #member-app .text-gray-400 { color: #4b5563 !important; }
    #member-app .text-gray-500 { color: #64748b !important; }
    /* 600/700 used to map to slate-400 / slate-300 — LIGHTER than the raw
       values, taking text already legible on a light background and making it
       worse (1.48:1 on white). They stay dark: 7.58:1 and 10.35:1. */
    #member-app .text-gray-600 { color: #475569 !important; }
    #member-app .text-gray-700 { color: #334155 !important; }
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

  // DARK is the canonical member theme and had NO override at all, so raw
  // Tailwind greys applied across 39 call sites in app/member and
  // components/member — clustered in exactly the copy that matters most:
  // "No classes today", "Your cart is empty", "No belt yet". Measured against
  // the dark page background:
  //
  //   the 700 tier  1.83:1   illegible
  //   the 600 tier  2.50:1   illegible
  //   the 500 tier  3.91:1   under the 4.5 floor
  //
  // Remapped as a gentle ramp so the intended hierarchy survives while every
  // tier clears AA on both the page background and the raised surface:
  // .60 = 7.22 / 6.91, .55 = 6.22 / 5.97, .50 = 5.33 / 5.19.
  // Done here rather than by editing 39 files: one rule covers every call site
  // and cannot be missed by a future paste of the same class.
  const darkModeCSS = !isLight ? `
    #member-app .text-gray-500 { color: rgba(255,255,255,0.60) !important; }
    #member-app .text-gray-600 { color: rgba(255,255,255,0.55) !important; }
    #member-app .text-gray-700 { color: rgba(255,255,255,0.50) !important; }
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
        // Semantic INKS for member-portal text. The shell flips between light
        // and dark per tenant, and the staff shell's inks (--hue-*-ink) are
        // tuned against white — #b91c1c on the dark shell measures ~2.4:1, so
        // an error message becomes the least readable thing on the page.
        // Publishing them here means member components never have to know
        // which way the tenant's shell went. Values live in globals.css so the
        // literals stay out of .tsx (UI-RULES §2).
        // ── Staff-token bridge ────────────────────────────────────────────
        // Shared primitives (Sheet, Dialog, Button, ConfirmDialog) are written
        // against the STAFF surface tokens — bg-sf-3, text-tx-1, border-bd-*.
        // Rendered inside the member portal they would paint a white panel with
        // dark ink on top of a dark tenant shell. Remapping the tokens here
        // means any shared primitive inherits the member theme automatically,
        // rather than each one growing a member-specific variant.
        //
        // Verified safe: member surfaces reference exactly ZERO of these
        // tokens today (`grep` over app/member + components/member returns 26
        // hits, all of them --tx-on-accent, which is published above). So
        // nothing existing changes colour; only shared primitives gain one.
        // --member-elevated (two lines up) already computes the raised-surface
        // colour for this shell, so point the primitives' panel tokens at it
        // rather than restating the literals — one source of truth, and no new
        // hex in .tsx (UI-RULES §2).
        ["--sf-1" as string]: surfaceBg,
        ["--sf-2" as string]: isLight ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.06)",
        ["--sf-3" as string]: "var(--member-elevated)",
        ["--sf-4" as string]: "var(--member-elevated)",
        ["--tx-1" as string]: textMain,
        ["--tx-2" as string]: textMuted,
        ["--tx-3" as string]: textMuted,
        ["--tx-4" as string]: isLight ? "rgba(0,0,0,0.4)" : "rgba(255,255,255,0.4)",
        ["--bd-default" as string]: surfaceBorder,
        ["--bd-hover" as string]: isLight ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.16)",
        ["--bd-active" as string]: isLight ? "rgba(0,0,0,0.24)" : "rgba(255,255,255,0.24)",

        ["--member-danger" as string]:  isLight ? "var(--hue-danger-ink)"  : "var(--hue-danger-ink-dark)",
        ["--member-success" as string]: isLight ? "var(--hue-success-ink)" : "var(--hue-success-ink-dark)",
        ["--member-warning" as string]: isLight ? "var(--hue-warning-ink)" : "var(--hue-warning-ink-dark)",
        ["--member-info" as string]:    isLight ? "var(--hue-info-ink)"    : "var(--hue-info-ink-dark)",
        // Tenant accent for primitives + links. Without this, controls using
        // var(--color-primary) (e.g. the Switch ON-state track) fell back to
        // the root greyscale token — a near-black blob on the dark shell
        // (Noe's "circle around the white circle" bug). --member-primary
        // fixes AnnouncementModal's previously-undefined fallback (audit P11).
        ["--color-primary" as string]: primary,
        ["--member-primary" as string]: primary,
        // §2a holistic customisation: readable foreground computed from the
        // tenant's actual accent, overriding the static #ffffff default —
        // a white or yellow gym colour still gets legible text on fills.
        ["--tx-on-accent" as string]: readableOn(primary),
      }}
    >
      {lightModeCSS && <style dangerouslySetInnerHTML={{ __html: lightModeCSS }} />}
      {darkModeCSS && <style dangerouslySetInnerHTML={{ __html: darkModeCSS }} />}
      {/* ── Top bar ── */}
      <header
        className="sticky top-0 shrink-0 z-20 member-topbar"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 14px)",
          paddingBottom: 14,
          // Fully opaque shell colour (no alpha suffix): scrolling content
          // passes under the sticky header, never under the bare OS status bar.
          background: appBg,
          borderBottom: `1px solid ${isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.06)"}`,
          // Noe 2026-08-20: "when I slide all the way up the members logo and
          // top part disappears." A sticky header travels WITH the document
          // when the browser rubber-bands past the top of the page, and the
          // strip revealed above it is painted by nothing — so the logo looks
          // like it slides away. `.member-topbar::before` (globals.css) extends
          // this same background upward to fill that strip. Kept as sticky
          // rather than fixed: fixed would need a spacer element and would
          // break the --member-header-clearance arithmetic every member page
          // already relies on.
          ["--member-topbar-bg" as string]: appBg,
        }}
      >
        {/* 3-column grid keeps the logo dead-centre against the screen.
            Without it the Shop bubble eats the right side and the logo
            visually drifts left on mobile (≈18px on a 375px viewport). */}
        <div className="grid grid-cols-[36px_minmax(0,1fr)_36px] items-center gap-2 px-4 w-full max-w-md mx-auto">
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
              {/* A Vercel Blob logo is private, so it renders through the
                  authenticated /api/blob-image proxy — which makes it a
                  same-origin path and therefore takes the plain <img> branch
                  below, exactly like a data: or local URL. */}
              {logoSrc.startsWith("data:") || logoSrc.startsWith("/") ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={logoSrc}
                  alt={gym.name}
                  style={{ height: 44, maxWidth: "100%", width: "auto", objectFit: "contain" }}
                />
              ) : (
                <Image
                  src={logoSrc}
                  alt={gym.name}
                  width={160}
                  height={44}
                  className="object-contain max-w-full h-auto"
                  style={{ maxHeight: 44 }}
                />
              )}
            </div>
          ) : gym.name ? (
            <div className="flex items-center gap-2.5 min-w-0">
              <div
                className="w-9 h-9 rounded-xl flex items-center justify-center font-bold text-sm shrink-0"
                style={{ background: primary, color: "var(--tx-on-accent)" }}
                aria-hidden="true"
              >
                {gym.name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
              <span
                className="font-bold text-lg tracking-tight leading-none truncate"
                style={{ color: isLight ? "#0f172a" : "#ffffff" }}
              >
                {gym.name}
              </span>
            </div>
          ) : (
            /* Branding not loaded yet — quiet shimmer, never a placeholder gym */
            <div className="h-9 w-32 rounded-xl animate-pulse" style={{ background: "rgba(255,255,255,0.06)" }} aria-hidden />
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

      {/* 2FA-optional spec (2026-05-07): banner shown only for password-bearing
          members who haven't enrolled. Component does its own /api/member/me
          fetch so the layout stays free of session plumbing. */}
      <Recommend2FABannerMember />

      {/* ── Content ──
          Width: the member portal is a phone app — on desktop it renders as a
          centred column, not a full-bleed 1440px stretch (audit U1/U3).
          Clearance: derived from the shared token (+ breathing room) instead
          of a second hardcoded 112px source of truth (audit C3). */}
      <main
        className="flex-1 overflow-y-auto w-full max-w-md mx-auto"
        style={{ paddingBottom: "calc(var(--member-nav-clearance) + 24px)" }}
      >
        {children}
      </main>

      {/* ── Bottom tab bar ── */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-30"
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
        {/* Tabs stay grouped in the same centred column as the content —
            at 1440px `justify-around` on the raw viewport spread four tabs
            ~300px apart (audit U2). */}
        <div className="w-full max-w-md mx-auto flex items-center justify-around">
        {TABS.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className="flex flex-col items-center justify-center gap-1 min-w-[56px] min-h-[48px] py-2 transition-transform active:scale-90"
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
        </div>
      </nav>
    </div>
  );
}
