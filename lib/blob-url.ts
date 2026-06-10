const BLOB_HOST_RE = /^https:\/\/[\w-]+(?:\.public)?\.blob\.vercel-storage\.com\//;

export function toBlobProxyUrl(url: string | null | undefined): string | null | undefined {
  if (!url) return url;
  if (BLOB_HOST_RE.test(url)) {
    return `/api/blob-image?url=${encodeURIComponent(url)}`;
  }
  return url;
}
