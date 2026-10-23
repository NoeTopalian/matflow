/**
 * Best-effort cache-tag invalidation that says when it fails (T2c, 17 Oct 2026).
 *
 * `revalidateTag` throws outside a Next request store (unit tests, scripts),
 * and the call sites used to wrap it in an empty `catch {}`, so a real
 * failure in production was invisible. The cache entry then simply expires
 * on its own clock, which is the documented fallback — so this never
 * rethrows and the save or undo that called it still succeeds — but it now
 * logs one structured warning.
 *
 * The log line carries the tag KIND (the tag with its `-<tenantId>` suffix
 * removed), the tenantId and the error's class name. Nothing else: no
 * message text, no personal data. Warn, not error, because a throw is
 * expected wherever there is no request store.
 */
import { revalidateTag } from "next/cache";

/** "gym-branding-t_123" with tenant "t_123" → "gym-branding". */
export function tagKind(tag: string, tenantId: string): string {
  const suffix = `-${tenantId}`;
  return tenantId && tag.endsWith(suffix) ? tag.slice(0, -suffix.length) : tag;
}

/** Returns true when the tag was revalidated, false when the call threw. */
export function revalidateTagLogged(tag: string, tenantId: string): boolean {
  try {
    revalidateTag(tag, { expire: 0 });
    return true;
  } catch (err) {
    console.warn("[cache] revalidateTag failed", {
      event: "revalidate_tag_failed",
      tagKind: tagKind(tag, tenantId),
      tenantId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    return false;
  }
}
