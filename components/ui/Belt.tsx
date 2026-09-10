/**
 * Belt — the belt graphic, extracted so there is ONE of them.
 *
 * NOT YET ADOPTED, and the commit that introduced it ("one Belt primitive,
 * replacing three implementations that disagreed") overstated: it replaces
 * none of them. Its only consumer today is components/print/MemberCardSheet.
 * The three below are untouched, so the same member can currently show one
 * belt on a printed card (unresolvable colour → neutral bar, empty slots for
 * unearned stripes) and a different one on their profile page (raw colour
 * string handed to CSS, no slots). Adopting it in the three call sites is a
 * real piece of work rather than a swap — each renders something different
 * today — and is filed as a follow-up, not done here.
 *
 * Three hand-rolled versions existed before this one and they disagreed with
 * each other on every axis that matters:
 *
 *   components/dashboard/MembersList.tsx  — looked `RankSystem.color` up in a
 *       map of colour WORDS ("white", "blue", …) and fell through to using the
 *       raw string as a CSS colour. Rendered as a text pill, not a belt.
 *   components/dashboard/MemberProfile.tsx — treated `color` as a CSS colour
 *       outright, drew a bar with a dark tab, and hardcoded white stripes that
 *       vanish on a white belt.
 *   components/dashboard/RanksManager.tsx  — writes `color` as a HEX literal,
 *       drew its own bar, and clamped stripes at four.
 *
 * `RankSystem.color` is free text, so BOTH live shapes are real data in the
 * same column and this primitive resolves both. Anything it cannot resolve is
 * treated as unknown rather than passed through to CSS, because an unparseable
 * value silently painting `transparent` is how a belt disappears.
 *
 * Two stripe counts, which the old code conflated:
 *   `MemberRank.stripes`  — what this member has been awarded. Drawn solid.
 *   `RankSystem.stripes`  — the maximum this belt can carry. Drawn as empty
 *                           slots after the earned ones, so a card shows
 *                           progress rather than an ambiguous run of marks.
 *
 * UNGRADED is a first-class state, not a missing one. The member importer
 * carries no rank data, so most members in a fresh tenant have no MemberRank
 * at all — and a laminated card asserting a grade nobody awarded is a factual
 * misstatement handed to a person. The ungraded rendering is deliberately not
 * belt-shaped: a dashed outline with the word, which cannot be mistaken for
 * the solid white bar of an actual white belt.
 *
 * Hex literals are allowed here because belt colours are DOMAIN DATA persisted
 * in `RankSystem.color`, not chassis colour (the same carve-out RanksManager
 * already documents), and because `components/ui/` is outside the UI-RULES
 * ratchet scan.
 */

import { readableOn } from "@/lib/color";

/** The colour WORDS that MembersList resolved, kept so old rows keep rendering. */
const BELT_WORDS: Record<string, string> = {
  white: "#f8f8f8",
  grey: "#6b7280",
  gray: "#6b7280",
  yellow: "#fbbf24",
  orange: "#f97316",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  brown: "#92400e",
  black: "#111111",
  red: "#ef4444",
  coral: "#fb923c",
};

/**
 * Resolve `RankSystem.color` — free text — to a hex colour, or `null` when it
 * is absent or unrecognisable. Accepts `#rgb`, `#rrggbb`, the same forms
 * without the leading hash, and the colour words above (case-insensitive).
 */
export function resolveBeltColour(color: string | null | undefined): string | null {
  if (!color) return null;
  const raw = color.trim();
  if (!raw) return null;

  const word = BELT_WORDS[raw.toLowerCase()];
  if (word) return word;

  const value = raw.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    return `#${value.split("").map((c) => c + c).join("")}`.toLowerCase();
  }
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value.toLowerCase()}`;

  return null;
}

export type BeltRank = {
  name: string;
  /** `RankSystem.color` — free text; a hex from RanksManager or a colour word. */
  color?: string | null;
  /** `MemberRank.stripes` — stripes this member has been awarded. */
  stripes?: number | null;
  /** `RankSystem.stripes` — the maximum this belt can carry. */
  maxStripes?: number | null;
};

export const UNGRADED_LABEL = "Ungraded";

/** True when there is nothing to assert about this member's grade. */
export function isUngraded(rank: BeltRank | null | undefined): boolean {
  return !rank || !rank.name.trim();
}

type BeltSize = "sm" | "md" | "lg";

const GEOMETRY: Record<
  BeltSize,
  { barH: number; barW: number; tabW: number; stripeW: number; minStripeW: number; fontPx: number }
> = {
  sm: { barH: 16, barW: 64, tabW: 14, stripeW: 5, minStripeW: 2, fontPx: 11 },
  md: { barH: 22, barW: 96, tabW: 20, stripeW: 7, minStripeW: 3, fontPx: 13 },
  lg: { barH: 34, barW: 150, tabW: 32, stripeW: 10, minStripeW: 4, fontPx: 18 },
};

/** The tab may take at most this much of the bar before it stops reading as a
 *  belt with a tab and starts reading as a two-tone bar. */
function tabCeiling(barW: number): number {
  return Math.round(barW * 0.72);
}

type StripeFit =
  | { kind: "marks"; stripeW: number; stripeGap: number; stripePad: number; tabW: number }
  | { kind: "count"; tabW: number };

/**
 * Fit `max` stripe slots onto the tab by SHRINKING the marks, not by dropping
 * them. The tab cannot grow past `tabCeiling`, so the previous code — fixed
 * mark width, fixed bar width, `overflow: hidden` — spilled stripes onto the
 * belt colour from about 8 and clipped them away entirely from about 11, while
 * its own doc comment told the next reader that could not happen. On a
 * laminated card that is an understated grade printed as fact: a kids' or
 * non-BJJ curriculum with `RankSystem.stripes` of 10 or 12 is ordinary data.
 *
 * Below a legibility floor, marks stop being marks. Rather than draw a row of
 * hairlines that cannot be counted, the tab falls back to the number itself
 * ("2/14"), which states the same fact and cannot be miscounted.
 */
function fitStripes(g: (typeof GEOMETRY)[BeltSize], max: number): StripeFit {
  const ceiling = tabCeiling(g.barW);
  for (let w = g.stripeW; w >= g.minStripeW; w--) {
    const stripeGap = Math.max(1, Math.round(w / 2));
    const stripePad = Math.max(2, Math.round(w / 2));
    const required = max * w + Math.max(0, max - 1) * stripeGap + stripePad * 2;
    if (required <= ceiling) {
      return {
        kind: "marks",
        stripeW: w,
        stripeGap,
        stripePad,
        tabW: Math.min(ceiling, Math.max(g.tabW, required)),
      };
    }
  }
  return { kind: "count", tabW: ceiling };
}

/** A belt whose own colour approaches either end of the shell's range needs a
 *  hairline or it vanishes — a white belt on a white card, a black belt on a
 *  dark preview. Measured against both extremes rather than a named list, so a
 *  tenant's custom near-white or near-black is covered too. */
function needsHairline(colour: string): boolean {
  return readableOn(colour) === "#0f172a" || colour.toLowerCase() === "#111111";
}

export function Belt({
  rank,
  size = "md",
  showLabel = true,
  className,
}: {
  rank: BeltRank | null | undefined;
  size?: BeltSize;
  showLabel?: boolean;
  className?: string;
}) {
  const g = GEOMETRY[size];

  if (isUngraded(rank)) {
    return (
      <span
        className={className}
        data-belt-state="ungraded"
        role="img"
        aria-label="Ungraded — no belt awarded"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          height: g.barH,
          minWidth: g.barW,
          padding: "0 10px",
          borderRadius: "var(--r-sm, 6px)",
          border: "1px dashed var(--bd-active, rgba(0,0,0,0.28))",
          background: "transparent",
          color: "var(--tx-3, rgba(0,0,0,0.55))",
          fontSize: g.fontPx,
          fontWeight: 600,
          letterSpacing: "0.02em",
          whiteSpace: "nowrap",
        }}
      >
        {UNGRADED_LABEL}
      </span>
    );
  }

  const graded = rank as BeltRank;
  const colour = resolveBeltColour(graded.color);
  const earned = Math.max(0, Math.floor(graded.stripes ?? 0));
  const rawMax = graded.maxStripes == null ? earned : Math.floor(graded.maxStripes);
  const max = Math.max(earned, Math.max(0, rawMax));

  // An unresolvable colour is drawn as a neutral bar with the name beside it.
  // Passing the raw string through to CSS was the old behaviour and it painted
  // nothing at all for any value the browser did not recognise.
  const fill = colour ?? "#9ca3af";
  const stripeInk = readableOn(fill) === "#0f172a" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.92)";
  const slotInk = readableOn(fill) === "#0f172a" ? "rgba(0,0,0,0.16)" : "rgba(255,255,255,0.26)";

  const stripeLabel =
    max > 0 ? `${graded.name}, ${earned} of ${max} stripe${max === 1 ? "" : "s"}` : graded.name;

  // The dark tab has to be wide enough to hold every stripe slot, or the marks
  // spill onto the belt colour and stop reading as stripes at all. It is
  // widened to fit and the marks are shrunk to fit within it; only when they
  // fall below the legibility floor does the tab print the count instead. See
  // fitStripes — the slot count is never silently reduced.
  const fit = fitStripes(g, max);
  const stripePad = fit.kind === "marks" ? fit.stripePad : Math.max(2, Math.round(g.stripeW / 2));

  return (
    <span
      className={className}
      data-belt-state={colour ? "graded" : "graded-unknown-colour"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        whiteSpace: "nowrap",
      }}
    >
      <span
        role="img"
        aria-label={stripeLabel}
        // The hairline is what stops a white belt disappearing on a white card
        // and a black one on the dark member shell. Surfaced as an attribute
        // because the border itself is a CSS custom property inside a
        // shorthand, which jsdom cannot read back.
        data-belt-hairline={needsHairline(fill) ? "on" : "off"}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: fit.kind === "marks" ? fit.stripeGap : 0,
          height: g.barH,
          width: g.barW,
          flexShrink: 0,
          borderRadius: "var(--r-sm, 4px)",
          background: fill,
          border: needsHairline(fill) ? "1px solid var(--bd-default, rgba(0,0,0,0.18))" : "1px solid transparent",
          // The tab is the dark band a real belt carries its stripes on. It is
          // drawn as an inset shadow rather than a child so the stripes can sit
          // on top of it without absolute positioning.
          boxShadow: `inset -${fit.tabW}px 0 0 0 rgba(0,0,0,0.34)`,
          paddingRight: stripePad,
          overflow: "hidden",
        }}
      >
        {fit.kind === "marks" ? (
          Array.from({ length: max }).map((_, i) => (
            <span
              key={i}
              // Earned vs slot is the one thing three earlier implementations
              // got wrong, so it is addressable from a test.
              data-belt-stripe={i < earned ? "earned" : "slot"}
              style={{
                width: fit.stripeW,
                height: Math.round(g.barH * 0.62),
                borderRadius: 1,
                flexShrink: 0,
                background: i < earned ? stripeInk : "transparent",
                border: i < earned ? "none" : `1px solid ${slotInk}`,
              }}
            />
          ))
        ) : (
          <span
            data-belt-stripe="count"
            style={{
              fontSize: Math.max(9, Math.round(g.barH * 0.4)),
              fontWeight: 700,
              lineHeight: 1,
              color: stripeInk,
              whiteSpace: "nowrap",
            }}
          >
            {earned}/{max}
          </span>
        )}
      </span>
      {showLabel && (
        <span
          style={{
            fontSize: g.fontPx,
            fontWeight: 600,
            letterSpacing: "0.01em",
            color: "var(--tx-1, inherit)",
          }}
        >
          {graded.name}
        </span>
      )}
    </span>
  );
}

export default Belt;
