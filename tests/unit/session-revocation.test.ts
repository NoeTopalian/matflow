// Removing someone must actually remove them.
//
// The confirmation dialog on Settings → Staff says access is lost immediately.
// It was not: `auth.ts` read the current session version with `?.`, so a row
// that had been HARD-DELETED produced `undefined`, `undefined !== token.version`
// was never evaluated because the guard short-circuited on `!== undefined`, and
// the removed coach kept a working dashboard for the rest of the JWT's 30 days.
// Deleting a staff row cannot bump a sessionVersion on a row that no longer
// exists, so deletion — the most final thing an owner can do — was the one
// action the revocation check could not see.
//
// This lived inline inside a NextAuth config object, which is why a codebase
// with 1300 tests had none for it. Extracting it is half the fix.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

const { memberFindUniqueMock, userFindUniqueMock, captureExceptionMock } = vi.hoisted(() => ({
  memberFindUniqueMock: vi.fn(),
  userFindUniqueMock: vi.fn(),
  captureExceptionMock: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: captureExceptionMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findUnique: memberFindUniqueMock },
      user: { findUnique: userFindUniqueMock },
    }),
}));

import { checkSessionVersion } from "@/lib/session-revocation";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a deleted account is a revoked session", () => {
  it("REVOKES a staff token whose User row is gone", async () => {
    // The defect this file exists for. `findUnique` returns null on a hard
    // delete, the old code turned that into `undefined`, and `undefined` meant
    // "nothing to compare — carry on".
    userFindUniqueMock.mockResolvedValue(null);

    expect(await checkSessionVersion({ userId: "user-1", tokenVersion: 3 })).toBe("revoked");
  });

  it("REVOKES a member token whose Member row is gone", async () => {
    memberFindUniqueMock.mockResolvedValue(null);

    expect(await checkSessionVersion({ memberId: "mem-1", tokenVersion: 1 })).toBe("revoked");
  });
});

describe("version comparison", () => {
  it("revokes when the version has moved (password reset, log out everywhere)", async () => {
    userFindUniqueMock.mockResolvedValue({ sessionVersion: 4 });

    expect(await checkSessionVersion({ userId: "user-1", tokenVersion: 3 })).toBe("revoked");
  });

  it("allows a token whose version still matches", async () => {
    userFindUniqueMock.mockResolvedValue({ sessionVersion: 3 });

    expect(await checkSessionVersion({ userId: "user-1", tokenVersion: 3 })).toBe("ok");
  });

  it("reads the Member table for a member session, not the User table", async () => {
    memberFindUniqueMock.mockResolvedValue({ sessionVersion: 2 });

    expect(await checkSessionVersion({ memberId: "mem-1", userId: "user-1", tokenVersion: 2 })).toBe("ok");
    expect(memberFindUniqueMock).toHaveBeenCalledTimes(1);
    expect(userFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("a failure to check is not a pass", () => {
  it("returns 'unknown' rather than 'ok' when the lookup throws", async () => {
    userFindUniqueMock.mockRejectedValue(new Error("connection reset"));

    // The caller keeps the token — a database blip must not sign out every user
    // in the product — but it must never be reported as a successful check.
    expect(await checkSessionVersion({ userId: "user-1", tokenVersion: 3 })).toBe("unknown");
  });

  it("REPORTS the failure, because revocation is failing open while it lasts", async () => {
    userFindUniqueMock.mockRejectedValue(new Error("connection reset"));
    await checkSessionVersion({ userId: "user-1", tokenVersion: 3 });

    // The old code was a bare `catch { /* DB transient — keep token */ }`: a
    // silent, total, indefinite bypass of every revocation in the product. And
    // after the planned RLS role cutover, a policy REJECTION would land in this
    // same catch — the one failure that must never look like a blip.
    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock.mock.calls[0][1]).toMatchObject({
      tags: { area: "auth", control: "session-revocation", failMode: "open" },
    });
  });

  it("returns 'unknown' when the token identifies nobody", async () => {
    expect(await checkSessionVersion({ tokenVersion: 3 })).toBe("unknown");
    expect(userFindUniqueMock).not.toHaveBeenCalled();
    expect(memberFindUniqueMock).not.toHaveBeenCalled();
  });
});

describe("it survives the RLS role cutover", () => {
  it("goes through withRlsBypass, not the bare client", async () => {
    // Production connects as a BYPASSRLS role today, so the bare client worked
    // — and would keep appearing to work right up until the cutover, at which
    // point these lookups would return zero rows and EVERY revocation in the
    // product would fail open at once. Since `withRlsBypass` is mocked here to
    // supply the tx, a call reaching the mocks at all proves the wrapper is in
    // the path.
    userFindUniqueMock.mockResolvedValue({ sessionVersion: 1 });
    await checkSessionVersion({ userId: "user-1", tokenVersion: 1 });
    expect(userFindUniqueMock).toHaveBeenCalledTimes(1);
  });
});


describe("auth.ts survives the RLS role cutover", () => {
  it("makes no bare-client tenant-data lookup", () => {
    // Six of these existed: the demo-tenant upgrade (x2), the impersonation
    // target, the two revocation lookups, and the brand refresh. Every one
    // worked only because production connects as a BYPASSRLS role, and every
    // one would have returned zero rows after the planned cutover to the
    // restricted role — silently breaking session revocation, impersonation,
    // demo upgrade and branding at the same moment, with only the first of
    // those even looking like a security failure.
    //
    // A scan rather than a review, because "audit the call sites before the
    // cutover" is exactly the kind of instruction that gets read and not done.
    const src = readFileSync("auth.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    const bare = [...src.matchAll(/\bprisma\.(member|user|tenant)\.\w+/g)].map((m) => m[0]);
    expect(bare).toEqual([]);
  });
});