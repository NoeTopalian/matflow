// "Sign out" ends this session on the server — against the REAL table (Round 8, 16 Nov 2026).
//
// Runs as both database roles (matflow-verify-local db-tests.mjs: the owner, then the restricted runtime role
// matflow_app with RLS_ENFORCED=1). Pins, on Postgres:
//   - a recorded session id is refused by the real per-request check (one statement: person row + record), while the
//     same person's other session, at the same version, is admitted — staff and member;
//   - a pre-release token's derived id is refused the same way;
//   - recording twice is harmless;
//   - pruning removes only records past their expiry;
//   - the access model: the runtime role can neither see nor write a record except through the RLS-bypass helper.
// Disposable club, synthetic example.test data, removed afterwards. Skips without a database.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { checkSessionVersion } from "@/lib/session-revocation";
import { pruneExpiredRevocations, revokeSessionId } from "@/lib/session-signout";
import { REVOKED_SESSION_RETENTION_MS, newSessionId, sessionIdOf } from "@/lib/session-id";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!HAS_DB)("revoked sessions (real rows, both roles)", () => {
  const ids = { tenant: "", user: "", member: "" };
  const sids: string[] = [];
  const track = (sid: string) => {
    sids.push(sid);
    return sid;
  };

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      ids.tenant = (await tx.tenant.create({ data: { name: `RS Club ${STAMP}`, slug: `rs-${STAMP}` } })).id;
      ids.user = (
        await tx.user.create({
          data: { tenantId: ids.tenant, email: `owner-${STAMP}@example.test`, name: "Owner", role: "owner", passwordHash: "x", sessionVersion: 2 },
        })
      ).id;
      ids.member = (
        await tx.member.create({
          data: { tenantId: ids.tenant, name: "Member", email: `member-${STAMP}@example.test`, status: "active", sessionVersion: 1 },
        })
      ).id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      if (sids.length) await tx.revokedSession.deleteMany({ where: { sid: { in: sids } } });
      if (ids.member) await tx.member.deleteMany({ where: { id: ids.member } });
      if (ids.user) await tx.user.deleteMany({ where: { id: ids.user } });
      if (ids.tenant) await tx.tenant.deleteMany({ where: { id: ids.tenant } });
    });
  });

  it("a signed-out staff session is refused; the same person's other session, at the same version, is not", async () => {
    const here = track(newSessionId());
    const otherDevice = track(newSessionId());
    const check = (sid: string) => checkSessionVersion({ userId: ids.user, tokenVersion: 2, tenantId: ids.tenant, sid });
    expect(await check(here)).toBe("ok");
    await revokeSessionId(here);
    expect(await check(here)).toBe("revoked");
    expect(await check(otherDevice)).toBe("ok");
  });

  it("a signed-out member session is refused; the member's other session is not", async () => {
    const here = track(newSessionId());
    const other = track(newSessionId());
    await revokeSessionId(here);
    expect(await checkSessionVersion({ memberId: ids.member, tokenVersion: 1, tenantId: ids.tenant, sid: here })).toBe("revoked");
    expect(await checkSessionVersion({ memberId: ids.member, tokenVersion: 1, tenantId: ids.tenant, sid: other })).toBe("ok");
  });

  it("a pre-release token is refused under its derived id once one of its copies signs out", async () => {
    const oldToken = { id: ids.user, tenantId: ids.tenant, sessionVersion: 2 };
    const derived = track(sessionIdOf(oldToken)!);
    expect(await checkSessionVersion({ userId: ids.user, tokenVersion: 2, tenantId: ids.tenant, sid: derived })).toBe("ok");
    await revokeSessionId(derived);
    const anotherCopy = sessionIdOf({ ...oldToken, jti: "another-copy", iat: 9 })!;
    expect(await checkSessionVersion({ userId: ids.user, tokenVersion: 2, tenantId: ids.tenant, sid: anotherCopy })).toBe("revoked");
  });

  it("recording the same session twice is harmless and keeps the first record", async () => {
    const sid = track(newSessionId());
    const first = new Date();
    await revokeSessionId(sid, first);
    await revokeSessionId(sid, new Date(first.getTime() + 60_000));
    const rows = await withRlsBypass((tx) => tx.revokedSession.findMany({ where: { sid } }));
    expect(rows).toHaveLength(1);
    expect(rows[0].expiresAt.getTime()).toBe(first.getTime() + REVOKED_SESSION_RETENTION_MS);
  });

  it("pruning removes only records past their expiry", async () => {
    const expired = track(newSessionId());
    const live = track(newSessionId());
    await revokeSessionId(expired, new Date(Date.now() - 63 * DAY)); // expired a day ago
    await revokeSessionId(live, new Date(Date.now() - 61 * DAY)); // expires tomorrow
    await pruneExpiredRevocations();
    const left = await withRlsBypass((tx) => tx.revokedSession.findMany({ where: { sid: { in: [expired, live] } }, select: { sid: true } }));
    expect(left.map((r) => r.sid)).toEqual([live]);
  });

  it("access model: outside the RLS-bypass helper the runtime role sees and writes nothing", async () => {
    const sid = track(newSessionId());
    await revokeSessionId(sid);
    const [{ bypass }] = await prisma.$queryRaw<Array<{ bypass: boolean }>>`
      SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (process.env.RLS_ENFORCED === "1") expect(bypass).toBe(false);
    if (bypass) return; // the owner role bypasses RLS by its role attribute; the restricted pass proves the policy
    const visible = await prisma.$queryRaw<unknown[]>`SELECT 1 FROM "RevokedSession" WHERE "sid" = ${sid}`;
    expect(visible).toHaveLength(0);
    await expect(
      prisma.$executeRaw`INSERT INTO "RevokedSession" ("sid", "expiresAt") VALUES (${`forged-${STAMP}-abcdefghijk`}, now())`,
    ).rejects.toThrow(/row-level security|42501/);
    // Yet the per-request check, which goes through the helper, does see it.
    expect(await checkSessionVersion({ userId: ids.user, tokenVersion: 2, tenantId: ids.tenant, sid })).toBe("revoked");
  });
});
