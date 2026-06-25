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

/** True if `url` is a Vercel Blob URL (any store type). */
export function isVercelBlobUrl(url: string): boolean {
  return BLOB_HOST_RE.test(url);
}

/**
 * Route a Vercel Blob URL through the authenticated image proxy so private
 * blobs resolve. Non-blob URLs (including `data:` URLs) pass through unchanged
 * so they render directly in <img>/<Image>.
 */
export function toBlobProxyUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  if (BLOB_HOST_RE.test(url)) {
    return `/api/blob-image?url=${encodeURIComponent(url)}`;
  }
  return url;
}
