/**
 * Static guard: the kiosk never paints raw tenant branding into a style.
 *
 * Tenant.primaryColor / bgColor / textColor / fontFamily are edited by gym
 * staff and land in inline `style` objects. `fontFamily` in particular is a
 * CSS-injection vector — React does not sanitise style values, so a saved
 * font of `Inter; } html { display:none` escapes the declaration it was
 * written into. The member portal and the login page have validated these
 * since the CSS-injection sweep (app/member/layout.tsx, app/login/page.tsx,
 * lib/fonts.ts); components/kiosk/KioskPage.tsx was the one branded surface
 * still reading them raw, and it is the surface that renders unauthenticated
 * on a tablet by the front door.
 *
 * The rule this pins: inside KioskPage, a branding field may only be read on
 * a line that also validates or proxies it. Every other read goes through the
 * derived `brand` object.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILE = join(__dirname, "..", "..", "components", "kiosk", "KioskPage.tsx");
const src = readFileSync(FILE, "utf8");

const COLOUR_FIELDS = ["primaryColor", "bgColor", "textColor"] as const;
const GUARDS = ["isHexColor(", "isSafeFontFamily(", "toBlobProxyUrl("];

function unguardedReads(field: string): string[] {
  const needle = new RegExp(`\\btenant\\.${field}\\b`);
  return src
    .split(/\r?\n/)
    .filter((line) => needle.test(line) && !GUARDS.some((g) => line.includes(g)));
}

describe("kiosk tenant branding is validated before it reaches a style", () => {
  for (const field of COLOUR_FIELDS) {
    it(`tenant.${field} is only read through isHexColor`, () => {
      expect(unguardedReads(field)).toEqual([]);
    });
  }

  it("tenant.fontFamily is only read through isSafeFontFamily", () => {
    expect(unguardedReads("fontFamily")).toEqual([]);
  });

  it("tenant.logoUrl is only read through toBlobProxyUrl", () => {
    // Branding uploads are access:"private", so the raw blob URL is not
    // fetchable by a browser at all — the proxy is both the safe and the
    // working answer.
    expect(unguardedReads("logoUrl")).toEqual([]);
  });

  it("the validators it uses are the shared ones, not a local re-spelling of the font rule", () => {
    expect(src).toMatch(/import\s*\{[^}]*isSafeFontFamily[^}]*\}\s*from\s*["']@\/lib\/fonts["']/);
    expect(src).toMatch(/import\s*\{[^}]*toBlobProxyUrl[^}]*\}\s*from\s*["']@\/lib\/blob-url["']/);
  });

  it("falls back to a safe value rather than rendering an invalid one", () => {
    // A rejected value must not fall through as `undefined` — that would drop
    // the tenant's chrome entirely and leave white-on-white.
    for (const fallback of ["FALLBACK_BG", "FALLBACK_TEXT", "FALLBACK_PRIMARY", "FALLBACK_FONT"]) {
      expect(src, `${fallback} should be the fallback for its branding field`).toContain(fallback);
    }
  });
});
