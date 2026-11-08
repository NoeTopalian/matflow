import { isTenantBlobUrl } from "@/lib/blob-url";

/**
 * The club logo acceptance policy (T9b, Q9 E-9 option (a), 17 Oct 2026).
 *
 * A club's logo is shown on anonymous surfaces: the branded login, the kiosk,
 * the leaderboard and the opt-in public club page. Blob uploads are private
 * and `/api/blob-image` needs a session, so a blob-stored logo renders blank
 * there. The policy is therefore:
 *
 *   - new logo uploads are stored inline as a raster `data:` URL
 *     (`/api/upload?purpose=logo` never calls put());
 *   - a saved `logoUrl` must be a raster `data:` URL inside the 3 MB bound, or
 *     a blob URL under THIS club's own namespace (`/tenants/<tenantId>/` on our
 *     store);
 *   - external `https://` images, root-relative paths (including
 *     `/api/blob-image?url=…`), SVG and every other scheme are refused.
 *
 * Existing stored values are not migrated. A save that sends the value
 * already stored, unchanged, is not a new write of that value and is let
 * through (see `app/api/settings/route.ts`), so an owner whose club predates
 * this policy can still save an unrelated branding change.
 */

/** Raster types only: SVG is a script-execution context, not an image. */
export const LOGO_DATA_URL_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;

/** Hard bound on an inline logo, in characters (the `Tenant.logoUrl` column). */
export const LOGO_DATA_URL_MAX = 3_000_000;

/** Bound on an own-namespace blob URL. */
const LOGO_BLOB_URL_MAX = 2000;

export const LOGO_URL_REFUSED_MESSAGE =
  "The logo must be an image uploaded in Settings. Links to images on other sites are not accepted — upload the file instead.";

export const LOGO_URL_TOO_LARGE_MESSAGE =
  "That logo image is too large. Upload a smaller file.";

export type LogoUrlVerdict = { ok: true } | { ok: false; message: string };

export function logoUrlVerdict(value: string, tenantId: string): LogoUrlVerdict {
  if (value.startsWith("data:")) {
    if (value.length > LOGO_DATA_URL_MAX) return { ok: false, message: LOGO_URL_TOO_LARGE_MESSAGE };
    return LOGO_DATA_URL_RE.test(value) ? { ok: true } : { ok: false, message: LOGO_URL_REFUSED_MESSAGE };
  }
  if (value.length <= LOGO_BLOB_URL_MAX && isTenantBlobUrl(value, tenantId)) return { ok: true };
  return { ok: false, message: LOGO_URL_REFUSED_MESSAGE };
}

export function isAcceptableLogoUrl(value: string, tenantId: string): boolean {
  return logoUrlVerdict(value, tenantId).ok;
}
