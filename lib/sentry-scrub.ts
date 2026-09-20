/**
 * The single PII scrubber for every Sentry runtime (server, client, edge).
 *
 * It was duplicated across the three `sentry.*.config.ts` files and the edge
 * copy went missing once already (audit iter-1-infra A7I1-S-3: edge middleware
 * sees the `matflow_admin` cookie, whose value IS the shared admin secret, so
 * an unscrubbed edge event hands super-admin access to anyone with Sentry
 * access). One definition, imported three times, cannot drift again.
 *
 * What it removes:
 *   - the `cookie`, `x-admin-secret` and `authorization` request headers
 *   - the `token` and `code` query parameters, from `request.url` AND from
 *     `request.query_string`
 *   - `user.email` and `user.username`
 *
 * Why the two extra headers (2026-09-20 audit #4). `x-admin-secret` carries the
 * raw MATFLOW_ADMIN_SECRET — `lib/admin-auth.ts` compares that header against
 * the environment variable, so it is the super-admin credential in plaintext.
 * `authorization` carries `Bearer <CRON_SECRET>` on every cron route, which is
 * exactly the population of requests most likely to 500 and reach Sentry.
 * Header names are matched case-insensitively: the header bag is assembled by
 * whichever runtime produced the event, and `Cookie` would have sailed past the
 * old exact-match `delete`.
 *
 * Why the query parameters (2026-09-20 audit #6). `/api/magic-link/verify?token=…`
 * carries a live single-use login token in the URL, and `request.url` was not
 * scrubbed at all — a 500 on that route published a working credential to
 * Sentry. `code` goes with it (OAuth/2FA exchange codes travel the same way).
 * The rest of the URL is kept: the path is what makes the event diagnosable,
 * and only the secret-bearing values are replaced.
 *
 * `user.id` is deliberately KEPT. It is not directly identifying on its own,
 * and it is what makes an error reference actionable: the log line and the
 * Sentry event agree on which account hit the failure. Tenant id and the
 * error reference arrive as tags, applied per-event via `Sentry.withScope` at
 * the capture sites (`lib/api-error.ts`, `instrumentation.ts`, the route
 * `error.tsx` boundaries) — never via a global `Sentry.setTag`, because this
 * app does not run `withSentryConfig` and so has no per-request isolation
 * scope to write to safely.
 */

/** Mirrors `QueryParams` in @sentry/core — a query string arrives in any of three shapes. */
type QueryParams = string | { [key: string]: string } | Array<[string, string]>;

type ScrubbableEvent = {
  request?: {
    headers?: { [key: string]: string };
    url?: string;
    query_string?: QueryParams;
    // The PARSED cookie record some runtimes attach beside the header — the
    // same credentials by another name; dropped wholesale like the header.
    cookies?: unknown;
  };
  user?: { email?: string; username?: string };
};

/** Request headers whose VALUE is a credential. Compared lower-cased. */
const SECRET_HEADERS = new Set(["cookie", "x-admin-secret", "authorization"]);

/** Query parameters whose VALUE is a credential. Compared lower-cased. */
const SECRET_QUERY_PARAMS = new Set(["token", "code"]);

const REDACTED = "[redacted]";

/**
 * Replace secret-bearing values in a raw `a=1&b=2` query string.
 *
 * Returns the input untouched when nothing matched, so an event that carried
 * no secret keeps its query string byte-for-byte rather than being re-encoded
 * by `URLSearchParams`.
 */
function redactQueryString(raw: string): string {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return raw;
  }
  let touched = false;
  for (const key of Array.from(params.keys())) {
    if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      touched = true;
    }
  }
  return touched ? params.toString() : raw;
}

/**
 * Redact the query half of a URL, leaving scheme, host, path and fragment
 * intact. Deliberately string-surgery rather than `new URL()`: `request.url`
 * is sometimes a path-only value, and round-tripping through `URL` would
 * either throw on it or rewrite an absolute URL's encoding.
 */
function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const hash = url.indexOf("#", q);
  const query = hash === -1 ? url.slice(q + 1) : url.slice(q + 1, hash);
  const fragment = hash === -1 ? "" : url.slice(hash);
  return `${url.slice(0, q)}?${redactQueryString(query)}${fragment}`;
}

export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  const request = event.request;
  if (request?.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SECRET_HEADERS.has(name.toLowerCase())) delete request.headers[name];
    }
  }
  if (request && "cookies" in request) {
    delete request.cookies;
  }
  if (request && typeof request.url === "string") {
    request.url = redactUrl(request.url);
  }
  if (request) {
    const qs = request.query_string;
    if (typeof qs === "string") {
      // Sentry writes this with or without the leading "?" depending on runtime.
      const lead = qs.startsWith("?") ? "?" : "";
      request.query_string = lead + redactQueryString(lead ? qs.slice(1) : qs);
    } else if (Array.isArray(qs)) {
      request.query_string = qs.map(([key, value]) =>
        SECRET_QUERY_PARAMS.has(key.toLowerCase())
          ? ([key, REDACTED] as [string, string])
          : ([key, value] as [string, string]),
      );
    } else if (qs && typeof qs === "object") {
      for (const key of Object.keys(qs)) {
        if (SECRET_QUERY_PARAMS.has(key.toLowerCase())) qs[key] = REDACTED;
      }
    }
  }
  if (event.user) {
    delete event.user.email;
    delete event.user.username;
  }
  return event;
}
