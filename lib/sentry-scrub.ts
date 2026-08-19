/**
 * The single PII scrubber for every Sentry runtime (server, client, edge).
 *
 * It was duplicated across the three `sentry.*.config.ts` files and the edge
 * copy went missing once already (audit iter-1-infra A7I1-S-3: edge middleware
 * sees the `matflow_admin` cookie, whose value IS the shared admin secret, so
 * an unscrubbed edge event hands super-admin access to anyone with Sentry
 * access). One definition, imported three times, cannot drift again.
 *
 * Behaviour is unchanged from those three copies:
 *   - drop the `cookie` request header (session + admin cookies)
 *   - drop `user.email` and `user.username`
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

type ScrubbableEvent = {
  request?: { headers?: { [key: string]: string } };
  user?: { email?: string; username?: string };
};

export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.request?.headers) delete event.request.headers["cookie"];
  if (event.user) {
    delete event.user.email;
    delete event.user.username;
  }
  return event;
}
