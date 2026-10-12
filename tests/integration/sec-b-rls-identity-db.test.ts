// Security lane B (9 Oct 2026) — RLS behaviour on the IDENTITY tables (User,
// Member) and the token tables under the restricted role (SEC-021 test level I).
// TEST branch only. Run with q78/run-restricted.sh (matflow_app, RLS_ENFORCED=1,
// no BYPASSRLS): every cell asserts the database refuses on its own, with no
// application filter in the statement. Under the owner runner (neondb_owner,
// BYPASSRLS) the cells record that RLS is NOT in force for that role — the
// application-layer `where: { tenantId }` is then the only defence, which is the
// production-equivalent case until the production runtime role is established.
//
// Also pinned: `app.bypass_rls` is an ordinary custom setting that the
// restricted role can set itself (that is how withRlsBypass works), so RLS is a
// backstop against a forgotten tenant filter inside withTenantContext — not
// against code that chooses the bypass, and not against SQL injection.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SLUG = STAMP.toLowerCase();
const E = (who: string) => `${SLUG}-${who}@example.test`;

describe.skipIf(!HAS_DB)("RLS on identity tables", () => {
  const ids = { a: "", b: "", userB: "", memberB: "", memberA: "" };
  let enforced = false;
  let who = "";

  beforeAll(async () => {
    const r = await prisma.$queryRaw<Array<{ u: string; bypass: boolean; superuser: boolean }>>`
      SELECT current_user AS u, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    who = r[0].u;
    enforced = !r[0].bypass && !r[0].superuser;
    if (process.env.RLS_ENFORCED === "1") expect(enforced, `RLS_ENFORCED=1 but ${who} bypasses RLS`).toBe(true);
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `${STAMP} A`, slug: `${SLUG}-a` } });
      const b = await tx.tenant.create({ data: { name: `${STAMP} B`, slug: `${SLUG}-b` } });
      ids.a = a.id; ids.b = b.id;
      ids.userB = (await tx.user.create({ data: { tenantId: b.id, email: E("b-owner"), name: "B owner", role: "owner", passwordHash: "x" } })).id;
      ids.memberB = (await tx.member.create({ data: { tenantId: b.id, email: E("b-member"), name: "B member" } })).id;
      ids.memberA = (await tx.member.create({ data: { tenantId: a.id, email: E("a-member"), name: "A member" } })).id;
      await tx.passwordResetToken.create({ data: { tenantId: b.id, email: E("b-owner"), tokenHash: `${SLUG}-hash`, expiresAt: new Date(Date.now() + 3_600_000) } });
    });
  }, 120_000);

  afterAll(async () => {
    for (const tenantId of [ids.a, ids.b].filter(Boolean)) {
      await withRlsBypass(async (tx) => {
        await tx.passwordResetToken.deleteMany({ where: { tenantId } });
        await tx.member.deleteMany({ where: { tenantId } });
        await tx.user.deleteMany({ where: { tenantId } });
        await tx.tenant.delete({ where: { id: tenantId } });
      });
    }
    const left = await withRlsBypass((tx) => tx.tenant.count({ where: { slug: { startsWith: SLUG } } }));
    expect(left).toBe(0);
  }, 120_000);

  const bRows = () =>
    withRlsBypass(async (tx) => ({
      user: await tx.user.findUnique({ where: { id: ids.userB }, select: { email: true, role: true, tenantId: true, sessionVersion: true } }),
      member: await tx.member.findUnique({ where: { id: ids.memberB }, select: { email: true, tenantId: true, passwordHash: true } }),
    }));

  it("records the connected role and whether RLS is in force for it", () => {
    console.log(JSON.stringify({ lane: "B", currentUser: who, rlsInForce: enforced }));
    expect(typeof who).toBe("string");
  });

  it("in club A's context, club B's identity rows are invisible (no tenant filter in the statement)", async () => {
    const seen = await withTenantContext(ids.a, async (tx) => ({
      users: await tx.user.count({ where: { id: ids.userB } }),
      members: await tx.member.count({ where: { id: ids.memberB } }),
      byEmail: await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "User" WHERE lower("email") = ${E("b-owner")}`,
      tokens: await tx.passwordResetToken.count({ where: { email: E("b-owner") } }),
    }));
    if (!enforced) return; // owner role: RLS not in force (recorded above)
    expect(seen).toEqual({ users: 0, members: 0, byEmail: [{ n: BigInt(0) }], tokens: 0 });
  });

  it("in club A's context, an UPDATE of club B's login address / role / password matches nothing; B unchanged", async () => {
    const before = await bRows();
    const r = await withTenantContext(ids.a, async (tx) => ({
      u: await tx.user.updateMany({ where: { id: ids.userB }, data: { email: E("hijack"), role: "coach", sessionVersion: { increment: 1 } } }),
      m: await tx.member.updateMany({ where: { id: ids.memberB }, data: { email: E("hijack-m"), passwordHash: "attacker" } }),
      raw: await tx.$executeRaw`UPDATE "Member" SET "email" = ${E("hijack-raw")} WHERE "id" = ${ids.memberB}`,
    }));
    if (!enforced) {
      // Undo what a BYPASSRLS role was able to do, so later cells start equal.
      await withRlsBypass(async (tx) => {
        await tx.user.update({ where: { id: ids.userB }, data: { email: before.user!.email, role: before.user!.role, sessionVersion: before.user!.sessionVersion } });
        await tx.member.update({ where: { id: ids.memberB }, data: { email: before.member!.email, passwordHash: before.member!.passwordHash } });
      });
      return;
    }
    expect({ u: r.u.count, m: r.m.count, raw: r.raw }).toEqual({ u: 0, m: 0, raw: 0 });
    expect(await bRows()).toEqual(before);
  });

  it("in club A's context, a row cannot be INSERTED into club B or MOVED to club B (WITH CHECK)", async () => {
    if (!enforced) return;
    await expect(
      withTenantContext(ids.a, (tx) => tx.member.create({ data: { tenantId: ids.b, email: E("planted"), name: "Planted" } })),
    ).rejects.toThrow(/row-level security|policy/i);
    await expect(
      withTenantContext(ids.a, (tx) => tx.member.update({ where: { id: ids.memberA }, data: { tenantId: ids.b } })),
    ).rejects.toThrow(/row-level security|policy/i);
    expect(await withRlsBypass((tx) => tx.member.count({ where: { email: E("planted") } }))).toBe(0);
    expect((await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id: ids.memberA } }))).tenantId).toBe(ids.a);
  });

  it("with NO context at all, identity and token tables read as empty (default deny)", async () => {
    const r = await prisma.$transaction(async (tx) => ({
      users: await tx.user.count({ where: { id: { in: [ids.userB] } } }),
      members: await tx.member.count({ where: { id: { in: [ids.memberB, ids.memberA] } } }),
      tokens: await tx.passwordResetToken.count({ where: { tenantId: ids.b } }),
    }));
    if (!enforced) return;
    expect(r).toEqual({ users: 0, members: 0, tokens: 0 });
  });

  it("the restricted role can set app.bypass_rls itself: RLS is a backstop for withTenantContext, not a boundary against code that opts out", async () => {
    const r = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      return tx.member.count({ where: { id: ids.memberB } });
    });
    expect(r).toBe(1); // same for both roles — documented residual (SEC-021)
  });
});
