import { test, expect } from "@playwright/test";

/**
 * Every operator-plane mutation refuses a cross-origin request, over real HTTP.
 *
 * ## Why this surface, and why it was missed
 *
 * `tests/unit/csrf-coverage.test.ts` scans source for `assertSameOrigin`. That
 * catches an absent guard; it cannot catch a guard that is present and does not
 * fire. This drives the real routes on the real server.
 *
 * The operator plane had been excluded from the CSRF sweep on the reasoning
 * that it is token-authenticated and therefore exempt. It is not:
 * `lib/admin-auth.ts` also accepts a `matflow_admin` COOKIE, and a cookie rides
 * along on a cross-site form post. So suspending a club, transferring its
 * ownership, force-resetting an owner's password, stripping a member's second
 * factor, and starting a session AS THE GYM OWNER were all reachable from any
 * page an operator happened to have open.
 *
 * ## Why it asserts the BODY and not just the status
 *
 * These routes answer 403 for "not an operator" as well. A test that accepted
 * any 403 would pass identically with the guard deleted, because the auth check
 * behind it also returns 403 — the textbook vacuous security test. So each case
 * asserts the CSRF message specifically, which also proves the guard runs
 * BEFORE the auth check, i.e. it is reached by an unauthenticated attacker.
 */

const CSRF_REJECTED = /cross-origin request rejected|Origin or Referer header required/;

/** Every mutating operator handler, with a verb that reaches it. */
const OPERATOR_MUTATIONS: Array<{ path: string; method: "post" | "delete"; label: string }> = [
  { path: "/api/admin/create-tenant", method: "post", label: "create a club" },
  { path: "/api/admin/applications/abc123/approve", method: "post", label: "approve an application" },
  { path: "/api/admin/applications/abc123/reject", method: "post", label: "reject an application" },
  { path: "/api/admin/customers/abc123/suspend", method: "post", label: "suspend a club" },
  { path: "/api/admin/customers/abc123/suspend", method: "delete", label: "un-suspend a club" },
  { path: "/api/admin/customers/abc123/soft-delete", method: "post", label: "soft-delete a club" },
  { path: "/api/admin/customers/abc123/soft-delete", method: "delete", label: "restore a club" },
  { path: "/api/admin/customers/abc123/transfer-ownership", method: "post", label: "transfer ownership" },
  { path: "/api/admin/customers/abc123/force-password-reset", method: "post", label: "force a password reset" },
  { path: "/api/admin/customers/abc123/totp-reset", method: "post", label: "strip an owner's 2FA" },
  { path: "/api/admin/customers/abc123/member-totp-reset", method: "post", label: "strip a member's 2FA" },
  { path: "/api/admin/impersonate", method: "post", label: "impersonate an owner" },
  { path: "/api/admin/impersonate", method: "delete", label: "end an impersonation" },
];

test.describe("operator plane refuses cross-origin mutations", () => {
  for (const { path, method, label } of OPERATOR_MUTATIONS) {
    test(`${method.toUpperCase()} ${path} — ${label}`, async ({ request }) => {
      const res = await request[method](path, {
        headers: {
          origin: "https://evil.example.com",
          "content-type": "application/json",
        },
        data: {},
      });

      expect(res.status(), `${label} did not refuse a cross-origin request`).toBe(403);
      const body = await res.text();
      expect(
        body,
        `${label} returned 403, but for the WRONG reason — this is the auth check answering, not the CSRF guard, so the guard is either missing or sits behind auth where an unauthenticated attacker never reaches it`,
      ).toMatch(CSRF_REJECTED);
    });
  }

  test("a same-origin request gets PAST the CSRF guard", async ({ request, baseURL }) => {
    // The control. Without it, a guard that refused everything unconditionally
    // would pass every case above while breaking the operator console entirely.
    const res = await request.post("/api/admin/customers/abc123/suspend", {
      headers: { origin: baseURL!, "content-type": "application/json" },
      data: { reason: "same-origin control probe" },
    });

    const body = await res.text();
    expect(
      body,
      "a same-origin request was rejected as cross-origin — the guard is refusing the console itself",
    ).not.toMatch(CSRF_REJECTED);
    // It still fails, on AUTHENTICATION, which is the correct next gate.
    expect(res.status()).toBe(403);
    expect(body).toMatch(/Forbidden/);
  });
});
