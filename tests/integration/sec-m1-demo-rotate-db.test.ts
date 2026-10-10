/**
 * SF-109 rotation tool on the Neon TEST branch (security campaign iteration 2, lane M1 v2, 10 Oct 2026; authorised
 * by Noe 10 Oct 22:13 Italy — TEST only, dry run, synthetic fixtures; production execution not authorised).
 * Run through the guarded runners under BOTH roles (owner: att/run-engine.sh; matflow_app with RLS enforced:
 * q78/run-restricted.sh). The tool is spawned as a real process with the same role's URL from .env.test.
 *
 * Fixtures (prefix secm1-): tenant A with four @demo.matflow staff rows and one non-demo staff row; tenant B with one
 * @demo.matflow staff row (a control that proves the tenant scoping). Count-checked teardown.
 *
 * Proves: the dry run lists exactly the four ids and changes nothing; --ids bound to the wrong set aborts with nothing
 * changed; --confirm changes exactly those four password hashes (to bcrypt cost 12) and bumps exactly those four
 * sessionVersions by 1, writes four AuditLog rows, and — by xmin — wrote no other User row anywhere in the database;
 * the two control rows are byte-identical; the output carries no password, hash or full address; a session token
 * minted at the old version is REVOKED by lib/session-revocation's real check (and the new version is admitted);
 * a second --confirm rotates again.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: () => {} }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { checkSessionVersion } from "@/lib/session-revocation";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE_VAR = process.env.RLS_ENFORCED === "1" ? "RESTRICTED_DATABASE_URL" : "TEST_DATABASE_URL";
const STAMP = `secm1-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SCRIPT = path.join(process.cwd(), "scripts/readiness/demo-accounts-rotate.mjs");
const ACTION = "admin.demo_account.rotated";

type Row = { id: string; h: string; passwordHash: string; sessionVersion: number; xmin: string };
type Seed = { id: string; email: string; role: string; v0: number; tenant: "A" | "B"; demo: boolean };

const ids = { A: "", B: "", slugA: `${STAMP}-a`, slugB: `${STAMP}-b` };
const seeds: Seed[] = [];
const demo = () => seeds.filter((s) => s.tenant === "A" && s.demo);
const controls = () => seeds.filter((s) => !(s.tenant === "A" && s.demo));
const digest = (e: string) => createHash("sha256").update(e.trim().toLowerCase()).digest("hex").slice(0, 12);

async function rows(): Promise<Map<string, Row>> {
  const r = await withRlsBypass((tx) =>
    tx.$queryRaw<Row[]>`SELECT id, md5(u::text) AS h, "passwordHash", "sessionVersion", xmin::text AS xmin
      FROM "User" u WHERE "tenantId" IN (${ids.A}, ${ids.B})`,
  );
  return new Map(r.map((x) => [x.id, x]));
}

async function audits() {
  return withRlsBypass((tx) =>
    tx.auditLog.findMany({
      where: { tenantId: { in: [ids.A, ids.B] }, action: ACTION },
      select: { userId: true, entityId: true, entityType: true, metadata: true, tenantId: true },
    }),
  );
}

function tool(args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG[A-Z]/.test(k))) as unknown as NodeJS.ProcessEnv;
  const r = spawnSync(process.execPath, [SCRIPT, "--slug", ids.slugA, "--var", ROLE_VAR, ...args], {
    env, encoding: "utf8", timeout: 180_000,
  });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

/** Optional evidence capture: the tool's own output (ids, masked locals, digests — no addresses by construction). */
function evidence(label: string, out: string) {
  const dir = process.env.SECM1_EVIDENCE_DIR;
  if (!dir) return;
  const role = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
  fs.writeFileSync(path.join(dir, `item3-tool-output-${role}-${label}.txt`), `${out.trim()}\n`);
}

/** The captured output carries no full address, no local part, no hash and no password-shaped string. */
function expectClean(out: string, known: Map<string, Row>[]) {
  const low = out.toLowerCase();
  for (const s of seeds) {
    expect(low.includes(s.email.toLowerCase()), "a full address was printed").toBe(false);
    expect(low.includes(s.email.split("@")[0].toLowerCase()), "a local part was printed").toBe(false);
  }
  expect(/\$2[aby]\$/.test(out), "a bcrypt hash prefix was printed").toBe(false);
  for (const m of known) for (const r of m.values()) expect(out.includes(r.passwordHash), "a stored hash was printed").toBe(false);
  expect(/[A-Za-z0-9_-]{32,}/.test(out), "a password-length token was printed").toBe(false);
}

describe.skipIf(!HAS_DB)(`SF-109 demo-account rotation tool on TEST (${process.env.RLS_ENFORCED === "1" ? "matflow_app, RLS" : "owner"})`, () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? "";
    if (!url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) throw new Error("REFUSED: not the TEST branch");
    await withRlsBypass(async (tx) => {
      ids.A = (await tx.tenant.create({ data: { name: `${STAMP} A`, slug: ids.slugA, onboardingCompleted: true } })).id;
      ids.B = (await tx.tenant.create({ data: { name: `${STAMP} B`, slug: ids.slugB, onboardingCompleted: true } })).id;
      const plan: Array<Omit<Seed, "id">> = [
        { email: `${STAMP}-owner@demo.matflow`, role: "owner", v0: 0, tenant: "A", demo: true },
        { email: `${STAMP}-manager@demo.matflow`, role: "manager", v0: 3, tenant: "A", demo: true },
        { email: `${STAMP}-coach@demo.matflow`, role: "coach", v0: 0, tenant: "A", demo: true },
        { email: `${STAMP}-admin@demo.matflow`, role: "admin", v0: 7, tenant: "A", demo: true },
        { email: `${STAMP}-staff@example.test`, role: "manager", v0: 2, tenant: "A", demo: false },
        { email: `${STAMP}-bowner@demo.matflow`, role: "owner", v0: 1, tenant: "B", demo: true },
      ];
      for (const [i, p] of plan.entries()) {
        const u = await tx.user.create({
          data: {
            tenantId: p.tenant === "A" ? ids.A : ids.B, email: p.email, name: `secm1 ${p.role}`, role: p.role,
            passwordHash: `synthetic-secm1-not-a-hash-${i}`, sessionVersion: p.v0,
          },
        });
        seeds.push({ ...p, id: u.id });
      }
    }, { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    const t = [ids.A, ids.B].filter(Boolean);
    if (t.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: t } } });
      await tx.user.deleteMany({ where: { tenantId: { in: t } } });
      await tx.tenant.deleteMany({ where: { id: { in: t }, slug: { startsWith: "secm1-" } } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: t } } }),
      users: await tx.user.count({ where: { tenantId: { in: t } } }),
      audits: await tx.auditLog.count({ where: { tenantId: { in: t } } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0, audits: 0 });
  }, 120_000);

  let r0: Map<string, Row>;
  let r1: Map<string, Row>;

  it("positive control: before any rotation every seeded session version is admitted", async () => {
    r0 = await rows();
    expect(r0.size).toBe(6);
    for (const s of seeds) {
      expect(await checkSessionVersion({ userId: s.id, tokenVersion: s.v0, tenantId: s.tenant === "A" ? ids.A : ids.B })).toBe("ok");
    }
  });

  it("dry run lists exactly the four demo ids in the tenant and changes nothing", async () => {
    const { status, out } = tool([]);
    expect(status).toBe(0);
    expect(out).toContain("would rotate 4 accounts");
    expect(out).toContain("target: TEST ep-hidden-salad-abom7cg4");
    // The tool connected as the runner's role (matflow_app under RLS_ENFORCED=1).
    if (process.env.RLS_ENFORCED === "1") expect(out).toContain("role=matflow_app");
    else expect(out).not.toContain("role=matflow_app");
    evidence("dry-run", out);
    for (const s of demo()) {
      expect(out).toContain(`${s.id}  role=${s.role}  local=s***@demo.matflow  digest=${digest(s.email)}`);
    }
    for (const s of controls()) expect(out).not.toContain(s.id);
    expectClean(out, [r0]);
    const now = await rows();
    for (const [id, r] of r0) expect(now.get(id)?.h, `row ${id} unchanged`).toBe(r.h);
    expect(await audits()).toHaveLength(0);
  }, 180_000);

  it("--confirm bound to the wrong id set aborts and changes nothing", async () => {
    const { status, out } = tool(["--confirm", "--ids", demo().slice(0, 3).map((s) => s.id).join(",")]);
    expect(status).toBe(1);
    expect(out).toMatch(/ABORTED: --ids does not match/);
    expectClean(out, [r0]);
    const now = await rows();
    for (const [id, r] of r0) expect(now.get(id)?.h).toBe(r.h);
    expect(await audits()).toHaveLength(0);
  }, 180_000);

  it("--confirm rotates exactly the four: new bcrypt(12) hashes, sessionVersion +1, four audit rows, no other User row written; old sessions revoked", async () => {
    const { status, out } = tool(["--confirm", "--ids", demo().map((s) => s.id).join(",")]);
    expect(status, out.includes("ABORTED") ? "tool aborted" : "tool failed").toBe(0);
    expect(out).toContain("rotated 4 accounts");
    evidence("confirm", out);
    const xid = /xid=(\d+)/.exec(out)?.[1];
    expect(xid).toBeTruthy();
    r1 = await rows();
    expectClean(out, [r0, r1]);

    for (const s of demo()) {
      const a = r0.get(s.id)!;
      const b = r1.get(s.id)!;
      expect(b.passwordHash === a.passwordHash, "hash changed").toBe(false);
      expect(/^\$2[aby]\$12\$/.test(b.passwordHash), "bcrypt cost 12").toBe(true);
      expect(b.sessionVersion).toBe(s.v0 + 1);
    }
    for (const s of controls()) expect(r1.get(s.id)?.h, `control ${s.role}/${s.tenant} byte-identical`).toBe(r0.get(s.id)!.h);

    // Every User row in the whole database this run's transaction wrote: exactly the four.
    const written = await withRlsBypass((tx) => tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE xmin::text = ${xid}`);
    expect(written.map((w) => w.id).sort()).toEqual(demo().map((s) => s.id).sort());

    const a = await audits();
    expect(a).toHaveLength(4);
    expect(a.map((x) => x.userId).sort()).toEqual(demo().map((s) => s.id).sort());
    for (const row of a) {
      const s = demo().find((d) => d.id === row.userId)!;
      expect(row).toMatchObject({ tenantId: ids.A, entityType: "User", entityId: s.id });
      expect((row.metadata as { emailDigest?: string }).emailDigest).toBe(digest(s.email));
    }

    // Session revocation, by the real check: a token minted at the old version is refused; the new one is admitted.
    for (const s of demo()) {
      expect(await checkSessionVersion({ userId: s.id, tokenVersion: s.v0, tenantId: ids.A })).toBe("revoked");
      expect(await checkSessionVersion({ userId: s.id, tokenVersion: s.v0 + 1, tenantId: ids.A }), "positive control").toBe("ok");
    }
    for (const s of controls()) {
      expect(await checkSessionVersion({ userId: s.id, tokenVersion: s.v0, tenantId: s.tenant === "A" ? ids.A : ids.B })).toBe("ok");
    }
  }, 180_000);

  it("a second --confirm rotates again", async () => {
    const { status, out } = tool(["--confirm"]);
    expect(status).toBe(0);
    const r2 = await rows();
    expectClean(out, [r0, r1, r2]);
    for (const s of demo()) {
      expect(r2.get(s.id)!.passwordHash === r1.get(s.id)!.passwordHash).toBe(false);
      expect(r2.get(s.id)!.sessionVersion).toBe(s.v0 + 2);
      expect(await checkSessionVersion({ userId: s.id, tokenVersion: s.v0 + 1, tenantId: ids.A })).toBe("revoked");
    }
    for (const s of controls()) expect(r2.get(s.id)?.h).toBe(r0.get(s.id)!.h);
    expect(await audits()).toHaveLength(8);
  }, 180_000);

  it("an unknown slug exits 3 and writes nothing", async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG[A-Z]/.test(k))) as unknown as NodeJS.ProcessEnv;
    const r = spawnSync(process.execPath, [SCRIPT, "--slug", `${STAMP}-nope`, "--var", ROLE_VAR, "--confirm"], { env, encoding: "utf8", timeout: 120_000 });
    expect(r.status).toBe(3);
    expect(await audits()).toHaveLength(8);
  }, 180_000);
});
