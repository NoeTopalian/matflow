// Session identity (Round 8, 16 Nov 2026): what makes "sign out" end THIS session and nothing else.
//
// Pins: a fresh id is unguessable and different every time; a pre-release token (no id) gets an id derived from its
// person, identical on every copy, so no copy of an old cookie can come back with a fresh, unrevoked id; a pre-release
// token mid-support gets none; the retention period follows from the session lifetime; and only the three sign-in
// paths mint ids.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  REVALIDATE_MAX_MS,
  REVOKED_SESSION_RETENTION_MS,
  SESSION_MAX_AGE_SECONDS,
  isSessionId,
  newSessionId,
  sessionIdOf,
} from "@/lib/session-id";

const DAY = 24 * 60 * 60 * 1000;

describe("a new session id", () => {
  it("is 128 random bits, url-safe, and never repeats", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newSessionId()));
    expect(ids.size).toBe(1000);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(isSessionId(id)).toBe(true);
    }
  });
});

describe("the session a token belongs to", () => {
  it("is the token's own id when it carries one", () => {
    const sid = newSessionId();
    expect(sessionIdOf({ sid, id: "u-1", memberId: null })).toBe(sid);
  });

  it("is derived from the PERSON for a pre-release token: every copy gets the same id", () => {
    // Two copies of the same old cookie, re-issued at different times: every claim but the person differs.
    const a = sessionIdOf({ id: "u-1", memberId: null, iat: 1, exp: 100, jti: "a", brandFetchedAt: 5 });
    const b = sessionIdOf({ id: "u-1", memberId: null, iat: 7, exp: 900, jti: "b", brandFetchedAt: 9 });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(isSessionId(a)).toBe(true);
    expect(a!.startsWith("legacy-")).toBe(true);
  });

  it("differs between people, and between a member and a staff account", () => {
    const staff = sessionIdOf({ id: "x-1" });
    const otherStaff = sessionIdOf({ id: "x-2" });
    const member = sessionIdOf({ id: "x-1", memberId: "x-1" });
    expect(new Set([staff, otherStaff, member]).size).toBe(3);
  });

  it("does not carry the person's id into the revocation table (it is a hash)", () => {
    const derived = sessionIdOf({ id: "cmw0l16c4000008l56w5bifqe", memberId: null })!;
    expect(derived).not.toContain("cmw0l16c4000008l56w5bifqe");
  });

  it("is none for a pre-release token in a support session (its id is the person being supported)", () => {
    expect(sessionIdOf({ supportCarrier: true })).toBeNull();
    expect(sessionIdOf({ id: "u-target", impersonatedBy: "op-1" })).toBeNull();
    expect(sessionIdOf({ id: "u-target", impersonatorClaims: { id: "u-op" } })).toBeNull();
  });

  it("is none for a token with no identity at all", () => {
    expect(sessionIdOf({})).toBeNull();
    expect(sessionIdOf({ sid: "short" })).toBeNull();
  });
});

describe("how long a revocation record is kept", () => {
  it("covers the last re-issue that can still happen after sign-out: two session lifetimes + the revalidation bound + a day", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(REVALIDATE_MAX_MS).toBe(DAY);
    expect(REVOKED_SESSION_RETENTION_MS).toBe(62 * DAY);
  });

  it("auth.ts uses the same session lifetime and revalidation bound", () => {
    const src = readFileSync("auth.ts", "utf8");
    expect(src).toMatch(/maxAge: SESSION_MAX_AGE_SECONDS/);
    expect(src).not.toMatch(/const REVALIDATE_MAX_MS\s*=/);
    expect(src).toMatch(/import \{[^}]*REVALIDATE_MAX_MS[^}]*\} from "@\/lib\/session-id"/);
  });
});

describe("only a sign-in mints a session id", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === "node_modules" ? [] : sources(p);
      return /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }

  it("newSessionId() is called from exactly the three sign-in paths", () => {
    const callers = [...sources("app"), ...sources("lib"), ...sources("components"), "auth.ts", "proxy.ts"]
      .filter((p) => !p.replace(/\\/g, "/").endsWith("lib/session-id.ts"))
      .filter((p) => /\bnewSessionId\(\)/.test(readFileSync(p, "utf8")))
      .map((p) => p.replace(/\\/g, "/"))
      .sort();
    expect(callers).toEqual([
      "app/api/admin/impersonate/route.ts", // a support session started in a clean browser (the carrier)
      "app/api/magic-link/verify/route.ts", // a magic-link sign-in
      "auth.ts", // a password or Google sign-in (jwt(), user branch)
    ]);
    // In auth.ts, only inside the sign-in branch.
    const auth = readFileSync("auth.ts", "utf8");
    expect(auth.match(/\bnewSessionId\(\)/g)).toHaveLength(1);
    const userBranch = auth.slice(auth.indexOf("async jwt({ token, user })"), auth.indexOf("A token minted before session ids"));
    expect(userBranch).toMatch(/\.sid = newSessionId\(\)/);
    // A whole-tree scan: under full-suite load it once exceeded the default per-test limit (review, 16 Nov 2026).
  }, 120_000);
});

describe("the arithmetic and the check cannot drift apart (review findings 4 and 7, 16 Nov 2026)", () => {
  it("every session cookie is issued with SESSION_MAX_AGE_SECONDS, never a literal lifetime", () => {
    for (const file of [
      "app/api/account/profile/route.ts",
      "app/api/auth/set-password/route.ts",
      "app/api/auth/totp/setup/route.ts",
      "app/api/auth/totp/verify/route.ts",
      "app/api/magic-link/verify/route.ts",
      "app/api/member/totp/setup/route.ts",
      "app/api/member/totp/verify/route.ts",
    ]) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/maxAge:\s*30 \* 24/);
      expect(src.match(/maxAge: SESSION_MAX_AGE_SECONDS/g)?.length ?? 0, file).toBeGreaterThanOrEqual(2);
    }
  });

  it("both production callers of the revocation check pass the session id", () => {
    expect(readFileSync("auth.ts", "utf8")).toMatch(/checkSessionVersion\([\s\S]{0,600}sid: sessionIdOf\(token/);
    expect(readFileSync("lib/auth-pending-gate.ts", "utf8")).toMatch(/sid: sessionIdOf\(token/);
  });
});
