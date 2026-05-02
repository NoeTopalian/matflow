/**
 * Centralised reader for NEXTAUTH_URL.
 *
 * Defensively trims whitespace and strips trailing slashes — caught a
 * real bug where the Vercel env var was pasted with a trailing newline
 * (`"https://matflow.studio\n"`), poisoning every email link / OAuth
 * redirect built from it (magic-link, member invite, password reset,
 * Stripe checkout return, Stripe Connect callback).
 *
 * Falls back to `req.url` origin if NEXTAUTH_URL is missing — matches
 * the existing pattern at most call sites (magic-link/request,
 * accept-invite, class-pack-buy, stripe-portal). Returns "" if neither
 * is available so callers can detect the empty case explicitly.
 */
export function getBaseUrl(req?: Request): string {
  const raw = process.env.NEXTAUTH_URL;
  if (raw && raw.trim().length > 0) {
    return raw.trim().replace(/\/+$/, "");
  }
  if (req) {
    try {
      return new URL(req.url).origin;
    } catch {
      /* malformed req.url — fall through */
    }
  }
  return "";
}
