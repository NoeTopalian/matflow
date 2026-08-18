// Detailed error reports (2026-08-18).
//
// lib/api-error.ts deliberately withholds internals from the client. This
// suite pins BOTH halves of that bargain:
//   - the client gets a reference, and nothing else that is internal;
//   - the server log gets the reference plus the full error, stack, route,
//     method, tenant, user and timestamp.
// The leak assertions are the load-bearing ones: a regression there is a
// security regression, not a cosmetic one.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

const sentry = vi.hoisted(() => ({
  scope: {
    setTag: vi.fn(),
    setUser: vi.fn(),
    setContext: vi.fn(),
  },
  captureException: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({
  withScope: (fn: (s: typeof sentry.scope) => void) => fn(sentry.scope),
  captureException: sentry.captureException,
}));

import { apiError } from "@/lib/api-error";
import { attachErrorContext } from "@/lib/error-context";
import { ERROR_REFERENCE_PATTERN } from "@/lib/error-reference";

/**
 * A realistic Prisma failure: the message names the model and the query, the
 * stack carries absolute developer paths, and the object hangs Prisma's own
 * error code and metadata off itself. Every one of those is a leak if it
 * reaches a gym member.
 */
function prismaFailure(): Error {
  const e = Object.assign(
    new Error(
      "Invalid `prisma.member.findMany()` invocation in\n" +
        "C:\\Users\\NoeTo\\Desktop\\matflow\\app\\api\\members\\route.ts:42:31\n\n" +
        'Raw query failed. Code: `42P01`. Message: `relation "public.Member" does not exist`',
    ),
    { code: "P2010", clientVersion: "7.0.1", meta: { table: "Member" } },
  );
  e.stack =
    "Error: Invalid `prisma.member.findMany()` invocation\n" +
    "    at Ic.handleRequestError (C:\\Users\\NoeTo\\Desktop\\matflow\\node_modules\\@prisma\\client\\runtime\\library.js:121:6958)\n" +
    "    at async withTenantContext (C:\\Users\\NoeTo\\Desktop\\matflow\\lib\\prisma-tenant.ts:44:12)";
  return e;
}

const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function lastLogCall(): unknown[] {
  return errorSpy.mock.calls.at(-1) as unknown[];
}

function loggedRecord(): Record<string, unknown> {
  return JSON.parse(lastLogCall()[1] as string) as Record<string, unknown>;
}

describe("a 500 carries a reference", () => {
  it("returns ok:false, the friendly message, and a well-formed reference", async () => {
    const res = apiError("Couldn't load members", 500, prismaFailure(), "[members]");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Couldn't load members");
    expect(body.reference).toMatch(ERROR_REFERENCE_PATTERN);
  });

  it("returns the SAME reference it wrote to the log", async () => {
    const res = apiError("Couldn't load members", 500, prismaFailure(), "[members]");
    const body = await res.json();
    expect(loggedRecord().reference).toBe(body.reference);
    expect(lastLogCall()[0]).toContain(body.reference);
  });

  it("mints a fresh reference per occurrence", async () => {
    const a = await apiError("Boom", 500, prismaFailure()).json();
    const b = await apiError("Boom", 500, prismaFailure()).json();
    expect(a.reference).not.toBe(b.reference);
  });

  it("attaches a reference to any status raised from a caught error", async () => {
    const body = await apiError("That email is already used", 409, new Error("unique"), "[patch]").json();
    expect(body.reference).toMatch(ERROR_REFERENCE_PATTERN);
  });

  it("omits the reference when nothing was logged for the owner to find", async () => {
    const body = await apiError("Invalid input", 400).json();
    expect(body).toEqual({ ok: false, error: "Invalid input" });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("a 500 never leaks internals to the client", () => {
  it("returns exactly ok, error and reference — no other keys", async () => {
    const body = await apiError("Couldn't load members", 500, prismaFailure(), "[members]", {
      tenantId: "tenant-1",
      userId: "user-1",
      method: "GET",
      path: "/api/members",
    }).json();
    expect(Object.keys(body).sort()).toEqual(["error", "ok", "reference"]);
  });

  it("leaks no stack frame, Prisma message, error code or internal path", async () => {
    const failure = prismaFailure();

    // Sanity: the fixture really does carry everything we are about to prove
    // absent, so the assertions below are testing something.
    expect(failure.message).toContain("prisma.member.findMany()");
    expect(failure.stack).toContain("node_modules");
    expect(failure.stack).toContain("C:\\Users");

    const body = await apiError("Couldn't load members", 500, failure, "[members]", {
      tenantId: "tenant-1",
      userId: "user-1",
    }).json();

    // Both the raw form and the JSON-escaped form (a leaked Windows path would
    // appear with doubled backslashes once serialised).
    const forms = [JSON.stringify(body), JSON.stringify(JSON.stringify(body))];
    for (const serialised of forms) {
      for (const secret of [
        "prisma",
        "Prisma",
        "P2010",
        "42P01",
        "findMany",
        "relation",
        "does not exist",
        "clientVersion",
        "node_modules",
        "Users",
        "matflow",
        "route.ts",
        "prisma-tenant",
        "    at ",
        "tenant-1",
        "user-1",
        "[members]",
      ]) {
        expect(serialised).not.toContain(secret);
      }
    }
  });

  it("leaks nothing for a non-Error throw either", async () => {
    const body = await apiError("Something went wrong", 500, {
      secret: "sk_live_deadbeef",
      sql: 'SELECT * FROM "Member"',
    }).json();
    expect(JSON.stringify(body)).not.toContain("sk_live");
    expect(JSON.stringify(body)).not.toContain("SELECT");
  });

  it("keeps third-party detail out even when the message is short", async () => {
    const body = await apiError("Couldn't refund", 500, new Error("stripe: no such charge ch_123")).json();
    expect(body.error).toBe("Couldn't refund");
    expect(JSON.stringify(body)).not.toContain("ch_123");
    expect(JSON.stringify(body)).not.toContain("stripe");
  });
});

describe("the server log is what the owner actually diagnoses with", () => {
  it("records reference, route, method, path, tenant, user, timestamp and stack", () => {
    const failure = prismaFailure();
    apiError("Couldn't load members", 500, failure, "[members]", {
      tenantId: "tenant-1",
      userId: "user-1",
      req: { method: "GET", url: "https://matflow.studio/api/members?page=2" },
    });

    const record = loggedRecord();
    expect(record.reference).toMatch(ERROR_REFERENCE_PATTERN);
    expect(record.route).toBe("[members]");
    expect(record.method).toBe("GET");
    expect(record.path).toBe("/api/members");
    expect(record.tenantId).toBe("tenant-1");
    expect(record.userId).toBe("user-1");
    expect(record.status).toBe(500);
    expect(String(record.at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const err = record.error as Record<string, string>;
    expect(err.message).toContain("prisma.member.findMany()");
    expect(err.stack).toContain("prisma-tenant.ts");

    // The raw error object must NOT be passed to console.error. Stripe SDK
    // errors carry .raw, .headers and, on PaymentIntent failures, a nested
    // payment_intent whose client_secret would then be serialised into the log
    // and forwarded to whatever ingests it — and that secret can confirm or
    // cancel the intent from a browser. Nothing diagnostic is lost: the stack
    // is already in the record above.
    expect(lastLogCall()).toHaveLength(2);
    expect(lastLogCall()[2]).toBeUndefined();
  });

  it("recovers the tenant from an error stamped by withTenantContext", () => {
    const failure = attachErrorContext(prismaFailure(), { tenantId: "tenant-from-tx" });
    apiError("Couldn't load members", 500, failure, "[members]");
    expect(loggedRecord().tenantId).toBe("tenant-from-tx");
  });

  it("prefers the caller's context over the stamped one", () => {
    const failure = attachErrorContext(prismaFailure(), { tenantId: "tenant-from-tx" });
    apiError("Couldn't load members", 500, failure, "[members]", { tenantId: "tenant-explicit" });
    expect(loggedRecord().tenantId).toBe("tenant-explicit");
  });

  it("logs null rather than guessing when the tenant is unknown", () => {
    apiError("Couldn't load members", 500, prismaFailure(), "[members]");
    const record = loggedRecord();
    expect(record.tenantId).toBeNull();
    expect(record.userId).toBeNull();
  });

  it("keeps the stamped context non-enumerable so it cannot be serialised out", () => {
    const failure = attachErrorContext(new Error("boom"), { tenantId: "tenant-1" });
    expect(JSON.stringify(failure)).not.toContain("tenant-1");
    expect(Object.keys(failure)).not.toContain("__matflowErrorContext");
  });
});

describe("Sentry", () => {
  it("tags the event with the reference and tenant, and only the user id", async () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    const body = await apiError("Couldn't load members", 500, prismaFailure(), "[members]", {
      tenantId: "tenant-1",
      userId: "user-1",
    }).json();

    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.scope.setTag).toHaveBeenCalledWith("error_reference", body.reference);
    expect(sentry.scope.setTag).toHaveBeenCalledWith("tenant_id", "tenant-1");
    expect(sentry.scope.setTag).toHaveBeenCalledWith("route", "[members]");
    // Only the id — never an email or a name (the config-level scrubber keeps
    // it that way for events raised elsewhere).
    expect(sentry.scope.setUser).toHaveBeenCalledWith({ id: "user-1" });
  });

  it("does not forward 4xx", () => {
    vi.stubEnv("SENTRY_DSN", "https://public@o0.ingest.sentry.io/1");
    apiError("That email is already used", 409, new Error("unique"), "[patch]");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it("stays silent when no DSN is configured", () => {
    vi.stubEnv("SENTRY_DSN", "");
    apiError("Couldn't load members", 500, prismaFailure(), "[members]");
    expect(sentry.captureException).not.toHaveBeenCalled();
  });
});
