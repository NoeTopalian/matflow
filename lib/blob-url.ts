// Permissive Vercel Blob host matcher — accepts every store-URL shape:
//   https://blob.vercel-storage.com/…               (no store subdomain)
//   https://<id>.blob.vercel-storage.com/…          (private store)
//   https://<id>.public.blob.vercel-storage.com/…   (public store)
//   …and any other subdomain labels Vercel may add.
// The leading subdomain group is OPTIONAL: the previous form required at least
// one label before `.blob`, so a bare `https://blob.vercel-storage.com/…` URL
// (a shape the upload route can return — see tests/unit/upload-blob.test.ts)
// was wrongly rejected by consumers, surfacing as "Invalid data" when saving a
// profile picture. The host is still anchored to blob.vercel-storage.com so
// this stays a strict allowlist (arbitrary origins remain rejected).
const BLOB_HOST_RE = /^https:\/\/([a-z0-9-]+\.)*blob\.vercel-storage\.com\//i;

/**
 * The store this deployment owns, read from BLOB_READ_WRITE_TOKEN the way
 * @vercel/blob does (`vercel_blob_rw_<storeId>_<secret>`), or null when the
 * token is absent or not in that shape (local, dev, unit tests).
 */
function ownStoreId(): string | null {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  const parts = token.split("_");
  if (parts.length < 5 || parts[0] !== "vercel" || parts[1] !== "blob") return null;
  const id = parts[3];
  return /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : null;
}

/**
 * True if `url` is a Vercel Blob URL MatFlow may read with its token.
 *
 * Security campaign lane C, SF-C1 (9 Oct 2026): any `*.blob.vercel-storage.com`
 * host used to pass, so a URL on a store somebody else owns — any free Vercel
 * account can create one — with a `/tenants/<id>/` path passed /api/blob-image's
 * namespace check. get() then sent `Bearer <BLOB_READ_WRITE_TOKEN>` to that host
 * and the route streamed the foreign object back from our origin under its own
 * Content-Type (image/svg+xml included). With a store token configured, only that
 * store's hosts (`<storeId>.private|public.blob.vercel-storage.com`) count. With
 * no well-formed token the permissive shape stays: get() cannot authenticate to
 * anything then, and local/dev/unit fixtures keep their arbitrary store names.
 */
export function isVercelBlobUrl(url: string): boolean {
  if (!BLOB_HOST_RE.test(url)) return false;
  const store = ownStoreId();
  if (!store) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === `${store}.private.blob.vercel-storage.com` || host === `${store}.public.blob.vercel-storage.com`;
}

/**
 * True if `url` is one of OUR blob URLs AND lives under this club's namespace
 * (`/tenants/<tenantId>/`, the prefix every upload path writes: upload,
 * imports, signatures, initiatives). Owner-path cross-tenant blob deletion
 * (security review of PR #31, 14 Oct 2026): a club could submit another
 * club's blob URL as a photo, then replace or delete it, and the store file
 * of the OTHER club was deleted. Accept-time check for every client-supplied
 * blob URL, and the filter before every del() of a stored one. `data:` and
 * same-origin `/api/blob/` paths are not blob URLs and are judged elsewhere.
 */
export function isTenantBlobUrl(url: string, tenantId: string): boolean {
  if (!tenantId || !isVercelBlobUrl(url)) return false;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return false;
  }
  // No encoded separators or dot-segments anywhere in the path: a store may
  // decode "%2F" or resolve ".." differently from the URL parser, so a path
  // that only LOOKS like it stays under the prefix is refused outright.
  // (A literal backslash never survives the parser: WHATWG normalises it to
  // "/" for https URLs, so only its encoded form needs refusing.)
  // Any percent-encoding at all is refused (double encoding such as "%252e"
  // would survive a narrower list): no path MatFlow writes contains one.
  if (/%|\.\./.test(pathname)) return false;
  return pathname.startsWith(`/tenants/${tenantId}/`);
}

/**
 * The one spelling of a stored file's URL: its origin and path and nothing else (lower-case host, no port, no
 * credentials, no query, no fragment, no trailing dot on the host). The upload route stores the blob's own URL, which is always in this form.
 * Ownership is decided by comparing stored URLs as strings, so a variant of a stored URL ("?v=1", "#x", an upper-case
 * host) names the same file under a different string and slipped past "is this a member's photo?" checks (re-review
 * of 12 Nov 2026). Comparing against `origin + pathname` also refuses an EMPTY query or fragment ("…webp?",
 * "…webp#"), which the URL parser keeps in `href` but reports as an empty `search`/`hash` (fix re-review 4, A1).
 * Every ownership rule accepts only this form.
 */
export function isCanonicalBlobUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return !u.port && !u.hostname.endsWith(".") && u.origin + u.pathname === url;
}

/**
 * Any spelling of a blob-store host, including ones the strict matcher above does not recognise (an explicit
 * ":443", a trailing dot, a protocol-relative "//host/..." or "/\\host/..." that a browser resolves against the
 * page). The club-asset rules run on these too, so an odd spelling is refused rather than stored unchecked (fix
 * re-review 4, A3; round 2, A-R2). Parsed against a placeholder base so a relative spelling still yields its host.
 */
export function isBlobStoreHost(url: string): boolean {
  try {
    const host = new URL(url, "https://base.invalid").hostname.toLowerCase().replace(/\.$/, "");
    return host === "blob.vercel-storage.com" || host.endsWith(".blob.vercel-storage.com");
  } catch {
    return false;
  }
}

/**
 * Round 5 (11 Nov 2026): a blob uploaded FOR this member (profile picture or
 * member photo: `/api/upload` writes those under
 * `tenants/<club>/members/<member>/`). Club-namespace membership alone is not
 * ownership: a member could otherwise point their own picture at the club
 * logo or another member's photo and have it deleted, or read it through the
 * image proxy. Every member-photo write accepts only this (or an inline
 * image), and every member-photo delete only ever deletes this.
 */
export function isMemberBlobUrl(url: string, tenantId: string, memberId: string): boolean {
  if (!memberId || /[/%.]/.test(memberId) || !isCanonicalBlobUrl(url) || !isTenantBlobUrl(url, tenantId)) return false;
  return new URL(url).pathname.startsWith(`/tenants/${tenantId}/members/${memberId}/`);
}

/** An inline image the routes accept in place of a blob (the upload route's no-store fallback). */
export function isInlineImageUrl(url: string): boolean {
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(url);
}

/**
 * A blob-store URL (any scheme/host case, so "HTTPS://" cannot slip past a
 * case-sensitive prefix test) that is NOT under this club's namespace. The
 * accept-time refusal for every client-supplied photo/picture URL; data: and
 * same-origin paths are not blob URLs and are judged by each route's schema.
 */
export function isForeignBlobUrl(url: string, tenantId: string): boolean {
  return isVercelBlobUrl(url) && !isTenantBlobUrl(url, tenantId);
}

/**
 * Route a Vercel Blob URL through the authenticated image proxy so private
 * blobs resolve. Non-blob URLs (including `data:` URLs) pass through unchanged
 * so they render directly in <img>/<Image>.
 */
export function toBlobProxyUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  if (isVercelBlobUrl(url)) {
    return `/api/blob-image?url=${encodeURIComponent(url)}`;
  }
  return url;
}
