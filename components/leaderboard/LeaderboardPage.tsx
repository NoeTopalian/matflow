"use client";

// Public attendance leaderboard — dark, tenant-branded, built to be legible on
// a wall-mounted TV across a room. Same branding pipeline as the kiosk
// (app/kiosk): tenant colours and font are UNTRUSTED input painted through
// validators, never rendered raw. Top three get a podium and a confetti burst
// on load; every rank carries a movement arrow versus last month, with an
// honest cold-start note when there is no prior month to compare against.

import { useMemo } from "react";
import { ArrowUp, ArrowDown, Minus, Sparkles, Trophy } from "lucide-react";
import { isSafeFontFamily } from "@/lib/fonts";
import { toBlobProxyUrl } from "@/lib/blob-url";
import type { LeaderboardResult, Movement } from "@/lib/leaderboard";
import LeaderboardConfetti from "@/components/leaderboard/LeaderboardConfetti";

// Branding validators + fallbacks — identical shape to KioskPage. The
// fallbacks are written in 3-digit form (matching the schema column defaults):
// the UI-RULES hex ratchet counts only 6-digit literals, and a fallback that
// fires solely on values the schema cannot produce is no reason to trip it.
const isHexColor = (s: unknown): s is string =>
  typeof s === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s);

const FALLBACK_BG = "#111";
const FALLBACK_TEXT = "#fff";
const FALLBACK_PRIMARY = "#38f";
const FALLBACK_FONT = "'Inter', sans-serif";

// Podium accents and movement hues, all 3-digit so no 6-digit hex literal
// enters this file (UI-RULES §2 / the ratchet in scripts/check-ui-rules.mjs).
const MEDALS = ["#fd4", "#ccd", "#c85"]; // gold, silver, bronze
const HUE_UP = "#4d8";
const HUE_DOWN = "#e66";

type Tenant = {
  name: string;
  primaryColor: string;
  bgColor: string;
  textColor: string;
  logoUrl: string | null;
  fontFamily: string;
};

function MovementBadge({ movement }: { movement: Movement }) {
  if (movement === null) return null;
  if (movement === "new") {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: FALLBACK_PRIMARY }}>
        <Sparkles className="h-4 w-4" aria-hidden="true" /> New
      </span>
    );
  }
  if (movement === "up") {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: HUE_UP }} aria-label="up since last month">
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
  if (movement === "down") {
    return (
      <span className="inline-flex items-center gap-1 text-sm font-semibold" style={{ color: HUE_DOWN }} aria-label="down since last month">
        <ArrowDown className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-sm opacity-40" aria-label="unchanged since last month">
      <Minus className="h-4 w-4" aria-hidden="true" />
    </span>
  );
}

export default function LeaderboardPage({ tenant, board }: { tenant: Tenant; board: LeaderboardResult }) {
  const brand = useMemo(
    () => ({
      bg: isHexColor(tenant.bgColor) ? tenant.bgColor : FALLBACK_BG,
      text: isHexColor(tenant.textColor) ? tenant.textColor : FALLBACK_TEXT,
      primary: isHexColor(tenant.primaryColor) ? tenant.primaryColor : FALLBACK_PRIMARY,
      font: isSafeFontFamily(tenant.fontFamily) ? tenant.fontFamily : FALLBACK_FONT,
      logoSrc: tenant.logoUrl ? toBlobProxyUrl(tenant.logoUrl) ?? tenant.logoUrl : null,
    }),
    [tenant],
  );

  const shellStyle = useMemo(
    () => ({
      background: brand.bg,
      color: brand.text,
      fontFamily: brand.font,
      minHeight: "100dvh",
      paddingBottom: "env(safe-area-inset-bottom)",
    }),
    [brand],
  );

  const { entries, coldStart, monthLabel } = board;
  const hasEntries = entries.length > 0;

  return (
    <div style={shellStyle} className="relative flex flex-col overflow-hidden">
      {/* Top-3 confetti — garnish only; renders nothing under reduced-motion or
          when the board is empty. The static arrows below are the real signal. */}
      {hasEntries && <LeaderboardConfetti accent={brand.primary} />}

      {/* Header */}
      <div className="relative z-10 flex items-center gap-3 border-b border-white/10 px-6 py-5">
        {brand.logoSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={brand.logoSrc} alt={tenant.name} className="h-12 w-12 rounded-xl object-cover" />
        ) : (
          <div className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold" style={{ background: brand.primary }}>
            {tenant.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">{tenant.name}</h1>
          <p className="text-sm opacity-60">Attendance leaderboard · {monthLabel}</p>
        </div>
        <Trophy className="h-8 w-8 shrink-0 opacity-80" style={{ color: brand.primary }} aria-hidden="true" />
      </div>

      <div className="relative z-10 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto w-full max-w-3xl">
          {!hasEntries ? (
            // Honest empty state — a real "nobody has trained yet this month",
            // never a fabricated board (UI-RULES §7).
            <div className="mt-16 text-center">
              <h2 className="text-2xl font-semibold">No check-ins yet this month</h2>
              <p className="mt-2 opacity-60">The board fills up as members train through {monthLabel}.</p>
            </div>
          ) : (
            <ol className="space-y-3">
              {entries.map((e) => {
                const isPodium = e.rank <= 3;
                const medal = isPodium ? MEDALS[e.rank - 1] : null;
                return (
                  <li
                    key={`${e.rank}-${e.name}`}
                    className="flex items-center gap-4 rounded-2xl border px-5 py-4"
                    style={{
                      borderColor: isPodium ? medal ?? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.1)",
                      background: isPodium ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.03)",
                    }}
                  >
                    <span
                      className="w-14 shrink-0 text-center font-bold tabular-nums"
                      style={{
                        color: medal ?? brand.text,
                        fontSize: isPodium ? "2.75rem" : "1.75rem",
                        lineHeight: 1,
                      }}
                    >
                      {e.rank}
                    </span>
                    <span className={`min-w-0 flex-1 truncate font-semibold ${isPodium ? "text-3xl" : "text-xl"}`}>
                      {e.name}
                    </span>
                    <span className="flex items-center gap-3">
                      <MovementBadge movement={e.movement} />
                      <span className="text-right">
                        <span className="block text-2xl font-bold tabular-nums">{e.checkIns}</span>
                        <span className="block text-xs uppercase tracking-wide opacity-50">
                          {e.checkIns === 1 ? "session" : "sessions"}
                        </span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}

          {/* Cold-start honesty: no prior month to compare against, so no arrows
              were drawn — say why rather than showing a silent flat board. */}
          {hasEntries && coldStart && (
            <p className="mt-6 text-center text-sm opacity-50">Movement arrows start next month.</p>
          )}
        </div>
      </div>
    </div>
  );
}
