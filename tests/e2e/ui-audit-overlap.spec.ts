import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { STAFF_NAV } from "../../components/layout/routes";

import { suppressOnboardingWizard } from "./onboarding-gate";
import { RUN_STAMP, cleanupRun, createMember } from "./campaign/helpers/db";

/**
 * UI regression guard — content trapped under sticky/fixed chrome.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOW TO RUN (this spec IS in the default matrix since 26 Sep 2026 — it runs
 * under the five `overlap-*` projects; the `chromium` project ignores the file
 * so it never runs twice. UI_OVERLAP_AUDIT=0 leaves the projects out of a
 * quick local run):
 *
 *   # everything (staff + member; desktop + tablet + mobile)
 *   npx playwright test tests/e2e/ui-audit-overlap.spec.ts
 *
 *   # one surface at a time
 *   npx playwright test --project="overlap-staff-desktop"
 *   npx playwright test --project="overlap-staff-tablet"     # 915×700, the DataTable band
 *   npx playwright test --project="overlap-staff-mobile"
 *   npx playwright test --project="overlap-member-desktop"
 *   npx playwright test --project="overlap-member-mobile"
 * ─────────────────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS
 * The staff Settings → Branding phone preview slid underneath the sticky tab
 * strip and its top was unreachable at every scroll position. The existing
 * guard (tests/e2e/ui-audit-staff.spec.ts §"buttons act and are not obscured")
 * could not see it: it probes only the LAST interactive element, only
 * <button>/<a>, only for bottom-edge obstruction, and only `if (isMobile)` —
 * while the broken element is `hidden lg:flex`, i.e. desktop-only, and is a
 * non-interactive panel. Every axis of that failure fell outside the net.
 *
 * WHAT THIS ASSERTS (all four axes closed)
 *  1. Runs on desktop AND mobile, over staff AND member routes.
 *  2. Chrome is discovered at RUNTIME — every element whose computed position
 *     is `sticky`/`fixed`, that is visible, that actually paints (opaque
 *     background-color, a background-image/gradient, or a backdrop-filter),
 *     and that can intercept a hit test. Transparent or `pointer-events:none`
 *     overlays are excluded by construction, so they cannot false-positive.
 *  3. Candidates are CONTENT, not just controls: panels and painted surfaces,
 *     images/canvas/svg, headings, any element with its own text, plus every
 *     non-chrome sticky/fixed element (that last rule is what makes the
 *     Branding preview visible to this test at all).
 *  4. The TOP edge is asserted explicitly against the nearest scrollable
 *     ancestor's client rect: no element may sit above its own scroll
 *     container's origin at every reachable scroll offset.
 *
 * THE TWO FAILURE MODES, AND WHY THEY ARE NOT JUST "OVERLAP"
 * Plain overlap is not a bug — content is supposed to scroll under a sticky
 * header. What makes it a bug is that no scroll position frees it. So:
 *
 *  a) PINNED-UNDER-CHROME (hard fail). The candidate is itself `sticky`/
 *     `fixed`, or lives inside such an element, and opaque chrome covers a
 *     substantial band of it. A pinned element does not scroll out from under
 *     anything — the covered band is lost for the whole of its sticky range.
 *     This is exactly the Branding-preview defect.
 *  b) NEVER-REVEALED (hard fail). A normal-flow candidate that is covered by
 *     opaque chrome at every sampled scroll offset AND still covered when
 *     scrolled directly into view.
 *  c) CLIPPED-ABOVE-SCROLL-ORIGIN (hard fail). The candidate's top edge is
 *     above its scrollport's client top at every sampled offset and remains
 *     so after a targeted scrollIntoView — i.e. it overflows upward past the
 *     scroll origin and cannot be brought back.
 *
 * Ordering is settled by hit testing (`elementFromPoint`), never by reading
 * z-index — that is both cheaper to get right and closer to what a user
 * experiences. The bug's root cause was precisely a z-index asymmetry
 * (`z-20` strip vs. an unlayered `position: sticky` preview).
 *
 * Runs as the seeded owner / seeded member via the existing storageState
 * projects. Asserts nothing about aesthetics — only reachability.
 */

test.describe.configure({ timeout: 120_000 });

// Safety: this suite must never run against prod (e2e resets TOTP state).
// playwright.config.ts force-loads .env.test, but assert anyway.
test.beforeAll(() => {
  const db = process.env.DATABASE_URL ?? "";
  if (db.includes("ep-bold-wave")) {
    throw new Error(
      "Overlap audit refused to run: DATABASE_URL points at the PROD Neon branch (ep-bold-wave). Use the .env.test branch.",
    );
  }
});

// The member first-run wizard (correctly) blocks everything behind it —
// report the member as onboarded so the audit drives the normal UI. This was a
// localStorage seed until the wizard's gate became the server flag; a browser
// key no longer suppresses anything. Harmless on staff routes, which never
// call /api/member/home.
test.beforeEach(async ({ page }) => {
  await suppressOnboardingWizard(page);
});

/* ───────────────────────────── routes ───────────────────────────── */

// Settings tabs are deep-linkable (`?tab=`), and each tab is a different DOM.
// The Branding tab is the one that carried the original defect, so tab state
// has to be enumerated — auditing `/dashboard/settings` alone only ever sees
// the default "overview" panel. Source: components/dashboard/SettingsPage.tsx
// `TABS` (overview is the default, hence not repeated here).
const SETTINGS_TABS = [
  "branding",
  "revenue",
  "store",
  "staff",
  "account",
  "waiver",
  "integrations",
];

const STAFF_ROUTES: string[] = [
  ...STAFF_NAV.filter((i) => i.roles.includes("owner")).map((i) => i.href),
  ...SETTINGS_TABS.map((t) => `/dashboard/settings?tab=${t}`),
];

// Mirrors the TABS list in app/member/layout.tsx plus the pinned Shop entry,
// same as tests/e2e/member/ui-audit-member.spec.ts.
const MEMBER_ROUTES = [
  "/member/home",
  "/member/schedule",
  "/member/progress",
  "/member/profile",
  "/member/shop",
];

const isMemberProject = (t: TestInfo) => t.project.name.includes("member");
const viewportLabel = (t: TestInfo) =>
  (t.project.use.viewport?.width ?? 1280) < 500 ? "mobile" : "desktop";

/* ───────────────────────────── helpers ───────────────────────────── */

// Same pattern as the member audit: the seeded member has unseen
// announcements and /member/home auto-opens one in a blocking modal.
async function dismissAnnouncement(page: Page) {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"], div.fixed.inset-0').last();
    if (!(await dialog.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    const close = page
      .locator('button[aria-label="Close"], button[aria-label="Dismiss"]')
      .last();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    await page.waitForTimeout(450);
  }
}

interface RectLike {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Finding {
  kind: "pinned-under-chrome" | "never-revealed" | "clipped-above-scroll-origin";
  selector: string;
  rect: RectLike;
  pinned: boolean;
  /** Human-readable one-liner explaining the mechanism. */
  why: string;
  chrome?: string;
  chromeRect?: RectLike;
  chromePosition?: string;
  overlapRect?: RectLike;
  /** Depth of the covered band, in px (the short side of the overlap). */
  overlapPx?: number;
  scrollport?: string;
  scrollportTop?: number;
  clippedPx?: number;
  /** scrollTop of the candidate's scrollport when the defect was observed. */
  observedAtScrollTop?: number;
}

interface AuditConfig {
  /** Minimum short-side depth of an overlap before it counts, in px. */
  minBandPx: number;
  /** Minimum overlap area before it counts, in px². */
  minAreaPx: number;
  /** Slack on the top-edge assertion, in px. */
  topTolerancePx: number;
  /** Cap on candidates walked, to bound runtime on huge pages. */
  maxCandidates: number;
}

const CONFIG: AuditConfig = {
  minBandPx: 8,
  minAreaPx: 400,
  topTolerancePx: 2,
  maxCandidates: 700,
};

/**
 * The whole probe runs inside ONE page.evaluate so that element identity
 * survives across scroll samples — "covered at EVERY offset" is not
 * computable if each sample is a separate round-trip. Setting `scrollTop`
 * and then reading `getBoundingClientRect()` forces a synchronous layout, and
 * sticky offsets are recomputed as part of that layout, so the loop measures
 * real pinned geometry without waiting for frames.
 */
async function runAudit(page: Page, cfg: AuditConfig): Promise<Finding[]> {
  return page.evaluate((c: AuditConfig): Finding[] => {
    const styleCache = new Map<Element, CSSStyleDeclaration>();
    const cs = (el: Element): CSSStyleDeclaration => {
      let s = styleCache.get(el);
      if (!s) {
        s = getComputedStyle(el);
        styleCache.set(el, s);
      }
      return s;
    };

    const round = (n: number) => Math.round(n * 10) / 10;
    const asRect = (r: { left: number; top: number; width: number; height: number }): RectLike => ({
      x: round(r.left),
      y: round(r.top),
      w: round(r.width),
      h: round(r.height),
    });

    function label(el: Element | null): string {
      if (!el) return "<none>";
      const id = el.id ? `#${el.id}` : "";
      const testid = el.getAttribute("data-testid");
      const tid = testid ? `[data-testid="${testid}"]` : "";
      const raw = typeof el.className === "string" ? el.className.trim() : "";
      const cls = raw ? "." + raw.split(/\s+/).slice(0, 3).join(".") : "";
      const txt = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
      return `${el.tagName.toLowerCase()}${id}${tid}${cls}${txt ? ` — "${txt}"` : ""}`;
    }

    function bgAlpha(colour: string): number {
      const m = /^rgba?\(([^)]+)\)/.exec(colour || "");
      if (!m) return 0;
      const parts = m[1].split(",").map((p) => parseFloat(p));
      return parts.length > 3 ? parts[3] : 1;
    }

    // "Opaque" = it actually paints over what is behind it. A gradient counts
    // (the Settings tab strip paints via `background: linear-gradient(...)`,
    // whose computed backgroundColor is rgba(0,0,0,0) — checking
    // backgroundColor alone would have missed the very bug this guards).
    // A backdrop-filter counts too: blurring the content behind it makes that
    // content unreadable even where the colour is translucent.
    function paints(s: CSSStyleDeclaration): boolean {
      if (bgAlpha(s.backgroundColor) >= 0.35) return true;
      if (s.backgroundImage && s.backgroundImage !== "none") return true;
      const bf =
        s.getPropertyValue("backdrop-filter") ||
        s.getPropertyValue("-webkit-backdrop-filter");
      return !!bf && bf !== "none";
    }

    function visible(el: Element): boolean {
      const s = cs(el);
      if (s.display === "none" || s.visibility === "hidden") return false;
      if (parseFloat(s.opacity || "1") < 0.05) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    }

    // Modals are a different problem (they are MEANT to cover the page) and
    // dialog stacking would swamp the signal — out of scope for this guard.
    const inModal = (el: Element) => !!el.closest('[role="dialog"], [aria-modal="true"]');

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Runtime chrome discovery. Re-run per sample: chrome can mount, unmount
    // or change background as the page scrolls.
    function collectChrome(): { el: Element; r: DOMRect }[] {
      const out: { el: Element; r: DOMRect }[] = [];
      for (const el of Array.from(document.querySelectorAll("*"))) {
        const s = cs(el);
        if (s.position !== "sticky" && s.position !== "fixed") continue;
        // Cannot intercept anything → cannot obstruct anything.
        if (s.pointerEvents === "none") continue;
        if (!visible(el) || inModal(el)) continue;
        if (!paints(s)) continue;
        const r = el.getBoundingClientRect();
        // A full-viewport pinned surface is a backdrop/overlay, not chrome;
        // treating it as chrome would flag every element on the page.
        if (r.width >= vw * 0.9 && r.height >= vh * 0.9) continue;
        out.push({ el, r });
      }
      return out;
    }

    const chromeInitial = collectChrome();
    const chromeSet = new Set(chromeInitial.map((c) => c.el));
    const insideChrome = (el: Element) =>
      chromeInitial.some((c) => c.el === el || c.el.contains(el));

    function pinnedAncestor(el: Element): Element | null {
      let node: Element | null = el;
      while (node && node !== document.body) {
        const p = cs(node).position;
        if ((p === "sticky" || p === "fixed") && !chromeSet.has(node)) return node;
        node = node.parentElement;
      }
      return null;
    }

    function isScrollable(el: Element): boolean {
      const oy = cs(el).overflowY;
      return (
        (oy === "auto" || oy === "scroll" || oy === "overlay") &&
        el.scrollHeight > el.clientHeight + 1
      );
    }

    // Nearest scrollable ancestor = the element's own scrollport. `fixed`
    // elements are anchored to the viewport instead.
    function scrollportOf(el: Element): Element | null {
      if (cs(el).position === "fixed") return null;
      let node: Element | null = el.parentElement;
      while (node && node !== document.documentElement) {
        if (isScrollable(node)) return node;
        node = node.parentElement;
      }
      return null;
    }

    function scrollportBox(sp: Element | null) {
      if (!sp) return { top: 0, left: 0, bottom: vh, right: vw, scrollTop: 0 };
      const r = sp.getBoundingClientRect();
      const s = cs(sp);
      const bt = parseFloat(s.borderTopWidth) || 0;
      const bl = parseFloat(s.borderLeftWidth) || 0;
      return {
        top: r.top + bt,
        left: r.left + bl,
        bottom: r.top + bt + sp.clientHeight,
        right: r.left + bl + sp.clientWidth,
        scrollTop: sp.scrollTop,
      };
    }

    /* ── candidates: CONTENT, not just controls ── */
    const CONTROL_SEL =
      'button, a[href], input, select, textarea, [role="button"], [role="switch"], [role="tab"], [role="link"]';
    const MEDIA = /^(IMG|SVG|CANVAS|VIDEO)$/;

    function hasOwnText(el: Element): boolean {
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === 3 && (n.textContent ?? "").trim().length > 1) return true;
      }
      return false;
    }

    const candidates: { el: Element; pinned: boolean; pinnedBy: Element | null }[] = [];
    for (const el of Array.from(document.querySelectorAll("main *, main"))) {
      if (candidates.length >= c.maxCandidates) break;
      if (!visible(el) || inModal(el) || insideChrome(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 12) continue;
      const s = cs(el);
      const painted =
        bgAlpha(s.backgroundColor) >= 0.35 ||
        (!!s.backgroundImage && s.backgroundImage !== "none");
      const isPanel = painted && r.width * r.height >= 5000;
      const pin = pinnedAncestor(el);
      const isContent =
        el.matches(CONTROL_SEL) ||
        MEDIA.test(el.tagName.toUpperCase()) ||
        /^H[1-6]$/.test(el.tagName.toUpperCase()) ||
        hasOwnText(el) ||
        isPanel ||
        !!pin;
      if (!isContent) continue;
      candidates.push({ el, pinned: !!pin, pinnedBy: pin });
    }

    /* ── scroll sampling plan ── */
    const scrollers: Element[] = [];
    if (document.scrollingElement) scrollers.push(document.scrollingElement);
    for (const el of Array.from(document.querySelectorAll("*"))) {
      if (isScrollable(el)) scrollers.push(el);
    }

    // Step small enough that every in-flow element's TOP edge lands inside the
    // scrollport at some sample — otherwise coarse sampling invents
    // "unreachable" elements that are merely un-sampled.
    let steps = 3;
    for (const sc of scrollers) {
      const max = sc.scrollHeight - sc.clientHeight;
      if (max <= 0) continue;
      const need = Math.ceil(max / Math.max(120, sc.clientHeight * 0.6)) + 1;
      if (need > steps) steps = need;
    }
    steps = Math.min(steps, 24);
    const fractions: number[] = [];
    for (let i = 0; i < steps; i++) fractions.push(steps === 1 ? 0 : i / (steps - 1));

    const restore = scrollers.map((sc) => sc.scrollTop);

    /* ── does the chrome actually win the paint order here? ── */
    function chromeWins(
      ol: { left: number; top: number; w: number; h: number },
      chromeEl: Element,
      candEl: Element,
    ): boolean {
      const pts: [number, number][] = [
        [ol.left + ol.w / 2, ol.top + ol.h / 2],
        [ol.left + ol.w * 0.2, ol.top + ol.h * 0.25],
        [ol.left + ol.w * 0.8, ol.top + ol.h * 0.25],
        [ol.left + ol.w * 0.2, ol.top + ol.h * 0.75],
        [ol.left + ol.w * 0.8, ol.top + ol.h * 0.75],
      ];
      const usable = pts.filter(([x, y]) => x >= 0 && y >= 0 && x < vw && y < vh);
      if (!usable.length) return false;
      let hits = 0;
      for (const [x, y] of usable) {
        const hit = document.elementFromPoint(x, y);
        if (!hit) continue;
        // Candidate paints on top here → not obstructed.
        if (hit === candEl || candEl.contains(hit)) continue;
        if (hit === chromeEl || chromeEl.contains(hit)) hits++;
      }
      return hits >= Math.ceil(usable.length / 2);
    }

    interface Cover {
      area: number;
      band: number;
      chromeEl: Element;
      chromeRect: RectLike;
      chromePosition: string;
      overlapRect: RectLike;
      candRect: RectLike;
      scrollTop: number;
    }

    function coverOf(candEl: Element, r: DOMRect, chromeNow: { el: Element; r: DOMRect }[]): Cover | null {
      let best: Cover | null = null;
      for (const ch of chromeNow) {
        // An ancestor container trivially "overlaps" the chrome it contains —
        // that is layout, not obstruction.
        if (ch.el === candEl || ch.el.contains(candEl) || candEl.contains(ch.el)) continue;
        const ox = Math.max(0, Math.min(r.right, ch.r.right) - Math.max(r.left, ch.r.left));
        const oy = Math.max(0, Math.min(r.bottom, ch.r.bottom) - Math.max(r.top, ch.r.top));
        if (ox * oy < c.minAreaPx) continue;
        if (Math.min(ox, oy) < c.minBandPx) continue;
        const ol = {
          left: Math.max(r.left, ch.r.left),
          top: Math.max(r.top, ch.r.top),
          w: ox,
          h: oy,
        };
        if (!chromeWins(ol, ch.el, candEl)) continue;
        const area = ox * oy;
        if (!best || area > best.area) {
          best = {
            area,
            band: round(Math.min(ox, oy)),
            chromeEl: ch.el,
            chromeRect: asRect(ch.r),
            chromePosition: cs(ch.el).position,
            overlapRect: { x: round(ol.left), y: round(ol.top), w: round(ox), h: round(oy) },
            candRect: asRect(r),
            scrollTop: 0,
          };
        }
      }
      return best;
    }

    interface Clip {
      px: number;
      candRect: RectLike;
      scrollport: string;
      scrollportTop: number;
      scrollTop: number;
    }

    const state = candidates.map(() => ({
      seen: false,
      everClear: false,
      everTopInside: false,
      worstCover: null as Cover | null,
      pinnedCover: null as Cover | null,
      bestClip: null as Clip | null,
    }));

    for (const f of fractions) {
      for (const sc of scrollers) {
        const max = sc.scrollHeight - sc.clientHeight;
        sc.scrollTop = max > 0 ? max * f : 0;
      }
      // Force layout so sticky offsets settle before anything is measured.
      void document.body.offsetHeight;
      const chromeNow = collectChrome();

      for (let i = 0; i < candidates.length; i++) {
        const cand = candidates[i];
        const st = state[i];
        if (!cand.el.isConnected || !visible(cand.el)) continue;
        const r = cand.el.getBoundingClientRect();
        const sp = scrollportOf(cand.el);
        const box = scrollportBox(sp);
        const inView =
          r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
        if (!inView) continue;
        st.seen = true;

        // TOP EDGE vs the scrollport's own origin.
        const clip = box.top - r.top;
        if (clip <= c.topTolerancePx && r.top < box.bottom) st.everTopInside = true;
        if (!st.bestClip || clip < st.bestClip.px) {
          st.bestClip = {
            px: round(clip),
            candRect: asRect(r),
            scrollport: sp ? label(sp) : "document viewport",
            scrollportTop: round(box.top),
            scrollTop: round(box.scrollTop),
          };
        }

        // OPAQUE CHROME COVERAGE.
        const cover = coverOf(cand.el, r, chromeNow);
        if (!cover) {
          st.everClear = true;
        } else {
          cover.scrollTop = round(box.scrollTop);
          if (!st.worstCover || cover.area > st.worstCover.area) st.worstCover = cover;
          if (cand.pinned && (!st.pinnedCover || cover.area > st.pinnedCover.area)) {
            st.pinnedCover = cover;
          }
        }
      }
    }

    /* ── targeted re-verification: kill sampling artefacts ──
       A candidate flagged by the coarse sweep gets one direct attempt to
       rescue itself — scrolled to the top of its own scrollport. Pinned
       candidates are exempt: "scroll it out from under" is the exact
       affordance that pinning removes, so the finding stands. */
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const st = state[i];
      if (!st.seen || cand.pinned) continue;
      const needsRecheck = (!st.everClear && st.worstCover) || !st.everTopInside;
      if (!needsRecheck) continue;
      if (!cand.el.isConnected) continue;
      cand.el.scrollIntoView({ block: "start", inline: "nearest" });
      void document.body.offsetHeight;
      const r = cand.el.getBoundingClientRect();
      const sp = scrollportOf(cand.el);
      const box = scrollportBox(sp);
      if (box.top - r.top <= c.topTolerancePx) st.everTopInside = true;
      if (!coverOf(cand.el, r, collectChrome())) st.everClear = true;
    }

    for (let i = 0; i < scrollers.length; i++) scrollers[i].scrollTop = restore[i];

    /* ── findings ── */
    const findings: Finding[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const st = state[i];
      if (!st.seen) continue;

      if (st.pinnedCover) {
        const cv = st.pinnedCover;
        findings.push({
          kind: "pinned-under-chrome",
          selector: label(cand.el),
          rect: cv.candRect,
          pinned: true,
          why:
            `This element is pinned (position:${cs(cand.pinnedBy ?? cand.el).position}` +
            `${cand.pinnedBy && cand.pinnedBy !== cand.el ? ` via ancestor ${label(cand.pinnedBy)}` : ""}) ` +
            `in the same scrollport as opaque ${cv.chromePosition} chrome that paints over it. ` +
            `A pinned element cannot be scrolled out from under anything, so the covered ` +
            `${cv.band}px band is unreachable for the whole of its sticky range. ` +
            `Fix by giving this element a z-index above the chrome, or by offsetting its ` +
            `sticky \`top\` past the chrome's height.`,
          chrome: label(cv.chromeEl),
          chromeRect: cv.chromeRect,
          chromePosition: cv.chromePosition,
          overlapRect: cv.overlapRect,
          overlapPx: cv.band,
          observedAtScrollTop: cv.scrollTop,
        });
      } else if (!st.everClear && st.worstCover) {
        const cv = st.worstCover;
        findings.push({
          kind: "never-revealed",
          selector: label(cand.el),
          rect: cv.candRect,
          pinned: cand.pinned,
          why:
            `Opaque ${cv.chromePosition} chrome covers a ${cv.band}px band of this element at ` +
            `EVERY sampled scroll offset, and it is still covered when scrolled directly into ` +
            `view. Add scroll padding/margin for the chrome, or move the element out from under it.`,
          chrome: label(cv.chromeEl),
          chromeRect: cv.chromeRect,
          chromePosition: cv.chromePosition,
          overlapRect: cv.overlapRect,
          overlapPx: cv.band,
          observedAtScrollTop: cv.scrollTop,
        });
      }

      if (!st.everTopInside && st.bestClip && st.bestClip.px > c.topTolerancePx) {
        const cl = st.bestClip;
        findings.push({
          kind: "clipped-above-scroll-origin",
          selector: label(cand.el),
          rect: cl.candRect,
          pinned: cand.pinned,
          why:
            `The top of this element sits ${cl.px}px above its scroll container's client top at ` +
            `every reachable scroll offset (best case measured). Nothing can scroll it back into ` +
            `view — it overflows upward past the scroll origin. Typical cause: a fixed height ` +
            `(e.g. calc(100vh - N)) with justify-content:center around content taller than the box.`,
          scrollport: cl.scrollport,
          scrollportTop: cl.scrollportTop,
          clippedPx: cl.px,
          observedAtScrollTop: cl.scrollTop,
        });
      }
    }
    return findings;
  }, cfg);
}

/** CI-readable failure report — enough to fix without reproducing locally. */
function formatFindings(url: string, viewport: string, findings: Finding[]): string {
  const shown = findings.slice(0, 6);
  const lines = [
    "",
    `${findings.length} element(s) trapped under sticky/fixed chrome on ${url} (${viewport}).`,
    "",
  ];
  shown.forEach((f, i) => {
    lines.push(`── [${i + 1}/${findings.length}] ${f.kind} ─────────────────────────────`);
    lines.push(`  element : ${f.selector}`);
    lines.push(`  rect    : x=${f.rect.x} y=${f.rect.y} w=${f.rect.w} h=${f.rect.h}`);
    lines.push(`  pinned  : ${f.pinned}`);
    if (f.chrome) {
      lines.push(`  chrome  : ${f.chrome}  (position:${f.chromePosition})`);
      lines.push(
        `  chrome rect : x=${f.chromeRect?.x} y=${f.chromeRect?.y} w=${f.chromeRect?.w} h=${f.chromeRect?.h}`,
      );
      lines.push(
        `  overlap : ${f.overlapPx}px band — x=${f.overlapRect?.x} y=${f.overlapRect?.y} w=${f.overlapRect?.w} h=${f.overlapRect?.h}`,
      );
    }
    if (f.scrollport) {
      lines.push(`  scrollport  : ${f.scrollport} (client top y=${f.scrollportTop})`);
      lines.push(`  clipped above origin by : ${f.clippedPx}px`);
    }
    lines.push(`  observed at scrollTop : ${f.observedAtScrollTop}`);
    lines.push(`  why     : ${f.why}`);
    lines.push("");
  });
  if (findings.length > shown.length) {
    lines.push(`  …and ${findings.length - shown.length} more (see the JSON attachment).`);
  }
  return lines.join("\n");
}

async function auditRoute(page: Page, url: string, testInfo: TestInfo) {
  const viewport = viewportLabel(testInfo);
  const res = await page.goto(url);
  expect(res?.status(), `${url} should not 404/500`).toBeLessThan(400);
  // Both DOM shells (desktop + mobile) exist at once — only ever match visible.
  await expect(page.locator("main:visible, h1:visible, h2:visible").first()).toBeVisible({
    timeout: 15_000,
  });
  // Bounded: this config sets no navigation timeout, so an unbounded
  // `networkidle` waited the whole 120s test budget whenever one API request
  // hung (a slow `GET /api/settings` against the remote test branch, 26 Sep
  // 2026 — reported as "Target page closed" at the NEXT call because the
  // catch swallowed the real timeout). The page is audited as it stands after
  // 15s; a request that never returns is not what this guard measures.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await dismissAnnouncement(page);

  // The audit drives scroll synchronously; smooth scrolling would make every
  // measurement land mid-animation. (globals.css scopes `scroll-behavior:
  // smooth` to the landing page, but belt and braces.)
  await page.addStyleTag({
    content: "html, body, * { scroll-behavior: auto !important; }",
  });

  // Warm-up pass with real frames so lazy/IntersectionObserver content mounts
  // BEFORE the synchronous measurement loop runs.
  await page.evaluate(async () => {
    const sc = document.scrollingElement;
    const mains = Array.from(document.querySelectorAll("main"));
    const targets: Element[] = sc ? [sc, ...mains] : mains;
    for (let f = 0; f <= 1.0001; f += 0.25) {
      for (const t of targets) {
        const max = t.scrollHeight - t.clientHeight;
        if (max > 0) t.scrollTop = max * f;
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    for (const t of targets) t.scrollTop = 0;
  });
  await page.waitForTimeout(300);

  const findings = await runAudit(page, CONFIG);

  if (findings.length) {
    await testInfo.attach(`overlap-${viewport}-${url.replace(/[/?=]/g, "_")}.json`, {
      body: JSON.stringify(findings, null, 2),
      contentType: "application/json",
    });
  }
  expect(findings.length, formatFindings(url, viewport, findings)).toBe(0);
}

/* ───────────────────────────── tests ───────────────────────────── */

test.describe("staff surfaces: nothing is trapped under sticky/fixed chrome", () => {
  for (const url of STAFF_ROUTES) {
    test(`staff ${url}`, async ({ page }, testInfo) => {
      test.skip(isMemberProject(testInfo), "staff routes run under the overlap-staff-* projects");
      await auditRoute(page, url, testInfo);
    });
  }
});

test.describe("member surfaces: nothing is trapped under sticky/fixed chrome", () => {
  for (const url of MEMBER_ROUTES) {
    test(`member ${url}`, async ({ page }, testInfo) => {
      test.skip(!isMemberProject(testInfo), "member routes run under the overlap-member-* projects");
      await auditRoute(page, url, testInfo);
    });
  }
});

/* ─────────── member profile → Payments tab: the hidden payment row ─────────── */

/**
 * The owner photographed a member's Payments tab at ≈915px: "2 records", a
 * blank band above the table header, only ONE row visible before "Total
 * recorded", and a sliver of a status pill peeking above the "Status" heading.
 *
 * Mechanism (reproduced 25 Sep 2026 with two single-variable interventions):
 * between 640 and 1023px the DataTable wrapper is `overflow-x-auto`, which
 * makes it the sticky header's nearest scroll container. A sticky box inside a
 * scrollport that never scrolls is still constrained — it is displaced by its
 * full `top`. With `stickyOffset="var(--staff-member-tabs-h)"` (45px) the
 * header sat 45px below its in-flow place and its `z-10` painted over the
 * 36px first row. Forcing `top: 0` OR `overflow: visible` each removed it.
 * The fix scopes the offset to `lg:` and up, where `<main>` is the scrollport.
 *
 * This cell fails on the old primitive at the tablet project (the first row's
 * centre hit-tests to the <thead>, and the header is 45px below the table's
 * top) and passes on the fixed one. It also runs the generic sweep on the same
 * URL so the whole-page guard, which never visited a member profile before,
 * covers it from now on. Two payments are seeded through the supported door
 * (`POST /api/payments/manual`) on a run-stamped member; the member and its
 * payments are removed by `cleanupRun` afterwards.
 */
test.describe("member profile Payments tab: the sticky header never covers a payment row", () => {
  let memberId: string | null = null;

  test.beforeAll(async ({ browser, baseURL }, testInfo) => {
    if (isMemberProject(testInfo)) return;
    const member = await createMember({ name: `${RUN_STAMP} Payments tab` });
    memberId = member.id;
    const ctx = await browser.newContext({ storageState: "tests/e2e/.auth/owner.json" });
    try {
      for (const [i, amountPence] of [8000, 4000].entries()) {
        const res = await ctx.request.post("/api/payments/manual", {
          headers: { Origin: baseURL! },
          data: {
            memberId: member.id,
            amountPence,
            method: "cash",
            notes: `${RUN_STAMP} payments tab ${i + 1}`,
            requestId: `${RUN_STAMP}-paytab-${i + 1}-${Math.random().toString(36).slice(2, 8)}`,
          },
        });
        expect(res.status(), `seeding payment ${i + 1} through /api/payments/manual`).toBe(201);
      }
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async () => {
    if (memberId) await cleanupRun();
  });

  test("both payment rows are visible and hittable; the header sits on the table's top edge", async ({ page }, testInfo) => {
    test.skip(isMemberProject(testInfo), "staff route: runs under the overlap-staff-* projects");
    if (!memberId) throw new Error("fixture member was not created");
    const url = `/dashboard/members/${memberId}?tab=payments`;

    const res = await page.goto(url);
    expect(res?.status(), `${url} should not 404/500`).toBeLessThan(400);
    await page.waitForLoadState("networkidle").catch(() => {});
    await dismissAnnouncement(page);

    // Count agreement: the tab badge, the "N records" line and the rendered rows.
    await expect(page.getByText("2 records")).toBeVisible();

    const table = page.getByRole("table", { name: "Payments for this member" });
    const viewportWidth = testInfo.project.use.viewport?.width ?? 1280;
    if (viewportWidth < 640) {
      // Below `sm:` the primitive renders cards, not a table — the sticky
      // header does not exist there. Assert the two cards instead.
      await expect(table).toBeHidden();
      // Both shells are in the DOM at once (the table hidden, the cards
      // shown), so match the card's own <p>, not any text on the page.
      await expect(page.locator("p", { hasText: `${RUN_STAMP} payments tab 1` })).toBeVisible();
      await expect(page.locator("p", { hasText: `${RUN_STAMP} payments tab 2` })).toBeVisible();
      await testInfo.attach(`payments-tab-${viewportWidth}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      return;
    }

    await expect(table).toBeVisible();
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(2);

    // Bring the card into view exactly as the owner had it: card top on screen,
    // below the rail. Then measure everything in one synchronous evaluate.
    await table.scrollIntoViewIfNeeded();
    await table.evaluate((table) => {
      // Scroll the nearest scroller so the table's top sits ~120px below the
      // scrollport's top — inside the band where the rail is above it.
      let node: HTMLElement | null = table.parentElement;
      while (node && node !== document.body) {
        const oy = getComputedStyle(node).overflowY;
        if ((oy === "auto" || oy === "scroll") && node.scrollHeight > node.clientHeight + 1) break;
        node = node.parentElement;
      }
      const scroller: Element = node && node !== document.body ? node : document.scrollingElement!;
      const spTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      const delta = table.getBoundingClientRect().top - spTop - 120;
      scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
      void document.body.offsetHeight;
    });

    // What the owner would see at this width, for the contact sheet.
    await testInfo.attach(`payments-tab-${viewportWidth}.png`, {
      body: await page.screenshot(),
      contentType: "image/png",
    });

    const geometry = await table.evaluate((table) => {
      const thead = table.querySelector("thead")!;
      const trs = Array.from(table.querySelectorAll("tbody tr"));
      const tableTop = table.getBoundingClientRect().top;
      // The sticky box is each <th>, not the <thead>: the row box stays in
      // flow while its cells are displaced, so measure a cell.
      const theadTop = thead.querySelector("th")!.getBoundingClientRect().top;
      const rowHits = trs.map((tr) => {
        const r = tr.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return {
          top: Math.round(r.top * 10) / 10,
          height: Math.round(r.height * 10) / 10,
          hitInsideRow: !!hit && tr.contains(hit),
          hitInsideThead: !!hit && thead.contains(hit),
          hitTag: hit ? hit.tagName : null,
        };
      });
      return {
        displacementPx: Math.round((theadTop - tableTop) * 10) / 10,
        theadPosition: getComputedStyle(thead.querySelector("th")!).position,
        rowHits,
      };
    });

    // At rest the header is where the table starts — never parked below it
    // over the first row. (It may only ever move DOWN from here on scroll at
    // lg: and up, when <main> scrolls the table under the rail.)
    expect(
      geometry.displacementPx,
      `the <thead> is ${geometry.displacementPx}px below the table's top edge at rest: ` +
        `the sticky offset is resolving against a scrollport that never scrolls (${JSON.stringify(geometry)})`,
    ).toBeLessThanOrEqual(1);

    for (const [i, hit] of geometry.rowHits.entries()) {
      expect(
        hit.hitInsideRow && !hit.hitInsideThead,
        `payment row ${i + 1} is covered: its centre hit-tests to <${hit.hitTag}> ` +
          `(${JSON.stringify(geometry)})`,
      ).toBe(true);
    }

    // Both amounts are on screen and the total agrees with the two rows.
    await expect(rows.nth(0)).toBeVisible();
    await expect(rows.nth(1)).toBeVisible();
    await expect(page.getByText("Total recorded")).toBeVisible();

    // And the whole-page guard over the same URL: the primitive's header is
    // sticky chrome that paints, so a covered first row is a "never-revealed"
    // finding for the generic sweep too.
    await auditRoute(page, url, testInfo);
  });
});
