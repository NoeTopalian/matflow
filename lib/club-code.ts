/**
 * The club code a person types on the login screen, normalised to the slug
 * the server knows. Approval mints slugs like `riverbank-grappling`; the login
 * box used to strip every non-alphanumeric, so the club's own code came back
 * "Club not found" (customer simulation, 26 Sep 2026, F-2).
 *
 * Accepts, in order: a pasted login link (`…/login?club=riverbank-grappling`),
 * a pasted club URL (`matflow.studio/riverbank-grappling`), or the code itself
 * in any case with stray spaces. Keeps hyphens, drops everything else the
 * server would refuse. Pure; unit-tested in tests/unit/customer-sim-fixes.test.ts.
 */
export function normaliseClubCode(raw: string): string {
  let s = (raw ?? "").trim();
  if (!s) return "";
  const param = s.match(/[?&]club=([^&#\s]+)/i);
  if (param) s = decodeURIComponent(param[1]);
  else if (/^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(s) || s.includes("/")) {
    const segments = s.replace(/[?#].*$/, "").split("/").filter(Boolean);
    const last = segments[segments.length - 1] ?? "";
    // `…/login` on its own carries no club; leave the raw value alone then.
    s = /^login$/i.test(last) ? "" : last;
  }
  return s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}

/** What the box may hold while typing: letters, digits and hyphens only. */
export function clubCodeInputFilter(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, "").toUpperCase();
}
