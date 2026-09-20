import { describe, it, expect } from "vitest";
import { scrubSentryEvent } from "@/lib/sentry-scrub";

// The scrubber is the last thing standing between a 500 and a credential in
// Sentry, and its whole surface is "what did we forget to delete". Each case
// below names the credential it is protecting, so a deletion from the header
// or parameter list fails with the reason rather than a diff.

describe("scrubSentryEvent — credential-bearing request headers", () => {
  it("drops the cookie header (session + matflow_admin, whose value IS the admin secret)", () => {
    const event = scrubSentryEvent({
      request: { headers: { cookie: "matflow_admin=s3cret; authjs.session-token=abc" } },
    });
    expect(event.request?.headers).not.toHaveProperty("cookie");
  });

  it("drops x-admin-secret — lib/admin-auth.ts compares it against MATFLOW_ADMIN_SECRET in plaintext", () => {
    const event = scrubSentryEvent({
      request: { headers: { "x-admin-secret": "the-raw-admin-secret" } },
    });
    expect(event.request?.headers).not.toHaveProperty("x-admin-secret");
  });

  it("drops authorization — cron routes carry Bearer CRON_SECRET and are the likeliest to 500", () => {
    const event = scrubSentryEvent({
      request: { headers: { authorization: "Bearer the-cron-secret" } },
    });
    expect(event.request?.headers).not.toHaveProperty("authorization");
  });

  it("matches header names case-insensitively — the bag is assembled by the runtime, not by us", () => {
    const event = scrubSentryEvent({
      request: {
        headers: { Cookie: "a=b", "X-Admin-Secret": "s", Authorization: "Bearer t" },
      },
    });
    expect(Object.keys(event.request?.headers ?? {})).toEqual([]);
  });

  it("keeps the diagnostic headers", () => {
    const event = scrubSentryEvent({
      request: {
        headers: { cookie: "a=b", "user-agent": "Mozilla/5.0", "content-type": "application/json" },
      },
    });
    expect(event.request?.headers).toEqual({
      "user-agent": "Mozilla/5.0",
      "content-type": "application/json",
    });
  });
});

describe("scrubSentryEvent — credential-bearing query parameters", () => {
  it("redacts the magic-link token out of request.url but keeps the path", () => {
    const event = scrubSentryEvent({
      request: { url: "https://matflow.studio/api/magic-link/verify?token=live-single-use-token&next=%2Fmember" },
    });
    expect(event.request?.url).not.toContain("live-single-use-token");
    expect(event.request?.url).toContain("/api/magic-link/verify");
    expect(event.request?.url).toContain("next=%2Fmember");
  });

  it("redacts `code` as well as `token`", () => {
    const event = scrubSentryEvent({
      request: { url: "https://matflow.studio/api/oauth/callback?code=exchange-code&state=xyz" },
    });
    expect(event.request?.url).not.toContain("exchange-code");
    expect(event.request?.url).toContain("state=xyz");
  });

  it("leaves a URL with no query string exactly as it was", () => {
    const url = "https://matflow.studio/dashboard/members";
    expect(scrubSentryEvent({ request: { url } }).request?.url).toBe(url);
  });

  it("leaves a URL whose query holds no secret byte-for-byte", () => {
    const url = "https://matflow.studio/api/reports?weeks=12";
    expect(scrubSentryEvent({ request: { url } }).request?.url).toBe(url);
  });

  it("keeps the fragment", () => {
    const out = scrubSentryEvent({
      request: { url: "https://matflow.studio/x?token=abc#section" },
    });
    expect(out.request?.url).not.toContain("abc");
    expect(out.request?.url?.endsWith("#section")).toBe(true);
  });

  it("redacts a string query_string, with or without the leading ?", () => {
    expect(
      scrubSentryEvent({ request: { query_string: "token=abc&next=/member" } }).request
        ?.query_string,
    ).not.toContain("abc");

    const withLead = scrubSentryEvent({ request: { query_string: "?token=abc" } }).request
      ?.query_string as string;
    expect(withLead.startsWith("?")).toBe(true);
    expect(withLead).not.toContain("abc");
  });

  it("redacts the record and tuple-array shapes of query_string", () => {
    expect(
      scrubSentryEvent({ request: { query_string: { token: "abc", weeks: "12" } } }).request
        ?.query_string,
    ).toEqual({ token: "[redacted]", weeks: "12" });

    expect(
      scrubSentryEvent({
        request: { query_string: [["token", "abc"], ["weeks", "12"]] as Array<[string, string]> },
      }).request?.query_string,
    ).toEqual([["token", "[redacted]"], ["weeks", "12"]]);
  });
});

describe("scrubSentryEvent — user identity", () => {
  it("drops email and username but keeps id, which is what makes an event actionable", () => {
    const event = scrubSentryEvent({
      user: { id: "usr_123", email: "member@example.com", username: "member" },
    });
    expect(event.user).toEqual({ id: "usr_123" });
  });

  it("is a no-op on an event with neither request nor user", () => {
    expect(scrubSentryEvent({})).toEqual({});
  });
});

describe("the parsed cookies record (audit follow-up)", () => {
  it("drops request.cookies wholesale — the header's credentials by another name", () => {
    const event = {
      request: { cookies: { matflow_admin: "the-secret", theme: "dark" }, headers: {} },
    };
    const out = scrubSentryEvent(event as never) as { request?: { cookies?: unknown } };
    expect(out.request && "cookies" in out.request).toBe(false);
  });
});
