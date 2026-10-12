// scripts/operator-access.mjs and the operator allowlist (admin hub lane B,
// 9 Oct 2026). "Only Noe" in practice: list prints every Operator.id so
// OPERATOR_ALLOWED_IDS can be set to Noe's; create and recover print the id and
// the reminder that production refuses an id that is not allow-listed. The
// script never sets the variable and never prints secrets.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  existing: null as null | { id: string },
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    operator = {
      findUnique: async () => h.existing,
      findMany: async () => h.rows,
    };
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn({
        $executeRaw: async () => 0,
        operator: { create: async () => ({ id: "op-created-1" }), update: async () => ({}) },
        auditLog: { create: async () => ({}) },
      });
    }
    async $disconnect() {}
  },
}));

const out: string[] = [];
const savedArgv = process.argv;
const saved = { url: process.env.DATABASE_URL, allow: process.env.OPERATOR_ALLOWED_IDS };

async function run(...args: string[]) {
  vi.resetModules();
  process.argv = ["node", "operator-access.mjs", ...args, "--confirm-host", "db.example"];
  try {
    await import("../../scripts/operator-access.mjs");
  } catch (e) {
    if (!/^exit 0$/.test((e as Error).message)) throw e;
  }
}

beforeEach(() => {
  h.existing = null;
  h.rows = [
    { id: "op-noe-id", email: "noe@example.test", name: "Noe", role: "super_admin", totpEnabled: true, lastLoginAt: null, lockedUntil: null },
    { id: "op-other-id", email: "other@example.test", name: "Other", role: "super_admin", totpEnabled: true, lastLoginAt: null, lockedUntil: null },
  ];
  out.length = 0;
  process.env.DATABASE_URL = "postgresql://user:pw@db.example/neondb";
  process.env.OPERATOR_PASSWORD = "a-supplied-operator-password";
  delete process.env.OPERATOR_ALLOWED_IDS;
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => {
  process.argv = savedArgv;
  if (saved.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.url;
  if (saved.allow === undefined) delete process.env.OPERATOR_ALLOWED_IDS; else process.env.OPERATOR_ALLOWED_IDS = saved.allow;
  delete process.env.OPERATOR_PASSWORD;
  vi.restoreAllMocks();
});

describe("operator-access.mjs: the ids the allowlist needs", () => {
  it("list prints every operator id and the production rule; never the database URL", async () => {
    await run("list");
    expect(out.find((l) => l.startsWith("id=op-noe-id "))).toBeTruthy();
    expect(out.find((l) => l.startsWith("id=op-other-id "))).toBeTruthy();
    expect(out.join("\n")).toMatch(/OPERATOR_ALLOWED_IDS/);
    expect(out.join("\n")).toMatch(/unset = nobody/);
    expect(out.join("\n")).not.toContain("user:pw");
  });

  it("list marks each id against OPERATOR_ALLOWED_IDS when it is set in the shell", async () => {
    process.env.OPERATOR_ALLOWED_IDS = " op-noe-id ";
    await run("list");
    expect(out.find((l) => l.startsWith("id=op-noe-id "))).toContain("allowlisted=yes");
    expect(out.find((l) => l.startsWith("id=op-other-id "))).toContain("allowlisted=NO");
  });

  it("create prints the new id and the allowlist reminder", async () => {
    await run("create", "--email", "new-op@example.test", "--name", "New Op", "--reason", "lane B test");
    expect(out.join("\n")).toContain("Operator id: op-created-1");
    expect(out.join("\n")).toMatch(/add op-created-1 to OPERATOR_ALLOWED_IDS/);
  });

  it("recover prints the unchanged id and the allowlist reminder", async () => {
    h.existing = { id: "op-noe-id" };
    await run("recover", "--email", "noe@example.test", "--reason", "lost phone");
    expect(out.join("\n")).toContain("Operator id: op-noe-id (unchanged by recover)");
    expect(out.join("\n")).toMatch(/OPERATOR_ALLOWED_IDS/);
  });
});
