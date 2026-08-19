/**
 * Canonical tenant font whitelist → Google Fonts import URLs.
 *
 * Defined ONCE here (UI-RULES §3) — do not copy this map into components.
 * This is the union of the three previously-duplicated copies
 * (app/login/page.tsx, app/member/layout.tsx, components/dashboard/SettingsPage.tsx):
 * the settings copy additionally carried Rajdhani and Playfair Display, and
 * the login/member copies additionally carried Teko. All are kept so no
 * tenant's saved font silently stops loading.
 */
export const FONT_IMPORTS: Record<string, string> = {
  Inter: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  Montserrat: "https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700;800&display=swap",
  Oswald: "https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&display=swap",
  "Plus Jakarta Sans": "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap",
  Barlow: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&display=swap",
  "Space Grotesk": "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap",
  "DM Sans": "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap",
  Teko: "https://fonts.googleapis.com/css2?family=Teko:wght@400;500;600;700&display=swap",
  Poppins: "https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap",
  Outfit: "https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap",
  Raleway: "https://fonts.googleapis.com/css2?family=Raleway:wght@400;500;600;700;800&display=swap",
  Saira: "https://fonts.googleapis.com/css2?family=Saira:wght@400;500;600;700&display=swap",
  Rajdhani: "https://fonts.googleapis.com/css2?family=Rajdhani:wght@400;500;600;700&display=swap",
  "Playfair Display": "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600;700;800&display=swap",
};

/** Extract the font name from a CSS value like `"'Montserrat', sans-serif"`. */
export function extractFontName(fontFamily: string): string {
  const match = fontFamily.match(/['"]?([^'",]+)['"]?/);
  return match ? match[1].trim() : "Inter";
}

/** Guard against CSS injection via tenant-controlled `fontFamily` values. */
export function isSafeFontFamily(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9 ,'"_-]+$/.test(s) && s.length < 100;
}
