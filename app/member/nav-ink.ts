/**
 * The member shell's tab-bar inks, and the light/dark rule they depend on.
 *
 * Extracted from `app/member/layout.tsx` for one reason: the inactive tab
 * label is 10px text on a tenant-coloured bar, and until round 4 nobody could
 * grade it without a browser. The campaign's legibility sweep measured it at
 * **2.43:1** on the seeded club — `rgba(0,0,0,0.35)` composited over a near
 * white bar — against a 4.5:1 requirement for text this size (WCAG 1.4.3;
 * "large text" starts at 18.66px bold / 24px, and this is neither).
 *
 * The values are washes rather than hex so the bar keeps working on any
 * tenant background: the ink darkens or lightens whatever the club chose,
 * instead of pinning one slate that only suits white. The alphas below are
 * the lowest that clear 4.5:1 at the extremes of each shell
 * (`tests/unit/member-nav-ink.test.ts` grades them), so the inactive tab
 * stays visibly subordinate to the active one — which is painted in the
 * tenant's accent — while still being readable.
 */

export type MemberNavInk = {
  /** True when the tenant's background is light enough for dark ink. */
  isLight: boolean;
  /** The bar's own background: the club's colour at 96% (light) or near-black. */
  navBg: string;
  /** The hairline above the bar. */
  navBorder: string;
  /** Icon + label ink for a tab that is NOT the current page. */
  inactiveCol: string;
};

/**
 * Light or dark shell, by perceived luma of the tenant background.
 * Unchanged from the inline version this replaces — the threshold (160) and
 * the ITU-R BT.601 weights are the rule the rest of the member portal is
 * already themed against, so moving it must not move it.
 */
export function isLightShell(appBg: string): boolean {
  const bgInt = parseInt((appBg.replace("#", "") + "000000").slice(0, 6), 16);
  const bgR = (bgInt >> 16) & 255;
  const bgG = (bgInt >> 8) & 255;
  const bgB = bgInt & 255;
  return (bgR * 299 + bgG * 587 + bgB * 114) / 1000 > 160;
}

export function memberNavInk(appBg: string): MemberNavInk {
  const isLight = isLightShell(appBg);
  return {
    isLight,
    navBg: isLight ? `${appBg}f5` : "rgba(10,11,14,0.97)",
    navBorder: isLight ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.07)",
    // 0.55 / 0.50, not 0.35 / 0.30. At 0.35 the label measured 2.43:1 on the
    // seeded club and 2.58:1 on the dark shell — a tab bar whose three other
    // destinations are, in practice, unreadable.
    inactiveCol: isLight ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.5)",
  };
}
