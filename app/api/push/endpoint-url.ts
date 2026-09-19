/**
 * What counts as a push endpoint.
 *
 * `z.string().url()` in zod 4.x is the WHATWG URL parser, so it answers `true`
 * for `javascript:alert(1)`, `data:…`, `file:///etc/passwd` and any internal
 * host — every one of which was being stored verbatim in `PushSubscription`.
 * Nothing sends yet (`lib/push.ts:11` returns early without VAPID keys), so
 * nothing has been fetched; the day a sender ships, `webpush.sendNotification`
 * would take whatever string is in that column and make the request from the
 * server. That is the SSRF surface, and it is cheaper to close now.
 *
 * A real endpoint is always an `https:` URL handed to the browser by a push
 * service (FCM, Mozilla autopush, WNS). Nothing in this repo registers an
 * `http:` one — the integration fixture, the DSAR fixtures and the campaign
 * specs all use `https://` — so there is no dev flow to keep alive and `http:`
 * is refused outright rather than special-cased for localhost.
 *
 * Kept out of `route.ts` deliberately: Next.js validates the export surface of
 * a route handler, so the predicate lives beside it and is unit-testable on its
 * own, with no auth or Prisma import pulled in.
 */

/** Longest endpoint we will store. FCM endpoints are ~200 characters. */
export const MAX_PUSH_ENDPOINT_LENGTH = 2000;

/**
 * True when `value` is an endpoint we are willing to store and, later, to make
 * a server-side request to.
 */
export function isAllowedPushEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_PUSH_ENDPOINT_LENGTH) return false;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // https only. `http:` (including localhost), and every non-network scheme
  // the WHATWG parser accepts — javascript:, data:, file:, blob:, ws: — are out.
  if (url.protocol !== "https:") return false;

  // `https://user:pass@host/…` — credentials in a stored URL are never a push
  // endpoint and would be replayed on every send.
  if (url.username !== "" || url.password !== "") return false;

  // A host is not optional: `https:/x` parses with an empty hostname.
  if (url.hostname === "") return false;

  return true;
}
