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
