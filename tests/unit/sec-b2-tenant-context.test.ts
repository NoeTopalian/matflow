// Security campaign iteration 2, lane B (SF-62) — unit level for lib/prisma-tenant.ts.
// The DB-level behaviour is measured by tests/integration/sec-b2-stale-bypass-db.test.ts (both roles) and
// scripts/readiness/rls-boundary-harness.mjs; this file pins the statement shape, the signed-context maths and a
// source invariant (no session-level app.* settings anywhere in the app).
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { txExecuteRaw, txQueryRaw } = vi.hoisted(() => ({
  txExecuteRaw: vi.fn().mockResolvedValue(1),
  txQueryRaw: vi.fn().mockResolvedValue([{ pid: "4242", ts: "1760000000123456" }]),
}));

vi.mock("@/lib/prisma", () => {
  const tx = { $executeRaw: txExecuteRaw, $queryRaw: txQueryRaw };
  return { prisma: { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});

import { withTenantContext, tenantContextKey, tenantContextMac, TENANT_CONTEXT_KEY_ENV } from "@/lib/prisma-tenant";

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("$");

describe("withTenantContext statement shape (SF-62)", () => {
  const saved = process.env[TENANT_CONTEXT_KEY_ENV];
  beforeEach(() => { txExecuteRaw.mockClear(); txQueryRaw.mockClear(); delete process.env[TENANT_CONTEXT_KEY_ENV]; });
  afterEach(() => { if (saved === undefined) delete process.env[TENANT_CONTEXT_KEY_ENV]; else process.env[TENANT_CONTEXT_KEY_ENV] = saved; });

  it("sets the tenant AND switches app.bypass_rls off for the transaction, in one statement, tenant as a bind parameter", async () => {
    await withTenantContext("tenant-A", async () => "ok");
    // R10-3 (lane L2): the context statement, then the liveness statement before COMMIT — nothing else.
    expect(txExecuteRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(txExecuteRaw.mock.calls[1])).toBe("SELECT 1");
    const call = txExecuteRaw.mock.calls[0];
    const sql = sqlOf(call);
    expect(sql).toMatch(/set_config\('app\.current_tenant_id', \$, true\)/);
    expect(sql).toMatch(/set_config\('app\.bypass_rls', 'off', true\)/);
    expect(call.slice(1)).toEqual(["tenant-A"]);
    expect(txQueryRaw).not.toHaveBeenCalled(); // signing is off without a key: no extra round trip
  });

  it("with a signing key, binds a MAC to the transaction's backend pid and start time", async () => {
    const key = randomBytes(64);
    process.env[TENANT_CONTEXT_KEY_ENV] = key.toString("hex");
    await withTenantContext("tenant-A", async () => "ok");
    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(txQueryRaw.mock.calls[0])).toMatch(/pg_backend_pid\(\)[\s\S]*transaction_timestamp\(\)/);
    expect(txExecuteRaw).toHaveBeenCalledTimes(3); // context, MAC, then the R10-3 liveness statement
    expect(sqlOf(txExecuteRaw.mock.calls[2])).toBe("SELECT 1");
    const macCall = txExecuteRaw.mock.calls[1];
    expect(sqlOf(macCall)).toMatch(/set_config\('app\.ctx_mac', \$, true\)/);
    expect(macCall[1]).toBe(createHmac("sha256", key).update("tenant-A|4242|1760000000123456").digest("hex"));
  });

  it("a malformed key fails closed before any transaction opens", async () => {
    process.env[TENANT_CONTEXT_KEY_ENV] = "abc";
    await expect(withTenantContext("tenant-A", async () => "ok")).rejects.toThrow(/64 bytes of hex/);
    expect(txExecuteRaw).not.toHaveBeenCalled();
  });

  it("still refuses an empty tenant id", async () => {
    await expect(withTenantContext("", async () => "ok")).rejects.toThrow(/non-empty tenantId/);
  });
});

describe("signed context maths agrees with the SQL formula in ctx_tenant()", () => {
  it("tenantContextMac == sha256(k^opad || sha256(k^ipad || msg)) for a 64-byte key (the pads the database stores)", () => {
    const key = randomBytes(64);
    const ipad = Buffer.from(key.map((b) => b ^ 0x36));
    const opad = Buffer.from(key.map((b) => b ^ 0x5c));
    const msg = Buffer.from("t1|99|123", "utf8");
    const inner = createHash("sha256").update(Buffer.concat([ipad, msg])).digest();
    const outer = createHash("sha256").update(Buffer.concat([opad, inner])).digest("hex");
    expect(tenantContextMac(key, "t1", "99", "123")).toBe(outer);
  });

  it("tenantContextKey: unset -> null, 64 bytes hex -> buffer, anything else throws", () => {
    expect(tenantContextKey(undefined)).toBeNull();
    expect(tenantContextKey("")).toBeNull();
    expect(tenantContextKey("ab".repeat(64))?.length).toBe(64);
    expect(() => tenantContextKey("ab".repeat(32))).toThrow();
    expect(() => tenantContextKey("zz".repeat(64))).toThrow();
  });
});

describe("source invariant: no SESSION-level app.* setting in application code", () => {
  // A set_config(..., false) or a plain SET app.x outside a transaction survives on the pooled server connection and
  // reaches the next client (C12 in the boundary harness). Only transaction-local settings are allowed in app/ lib/.
  const roots = ["app", "lib", "auth.ts", "proxy.ts"];
  const files: string[] = [];
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
    if (/\.(ts|tsx|mjs|js)$/.test(p)) files.push(p);
  };
  for (const r of roots) walk(path.resolve(process.cwd(), r));

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("every set_config of an app.* setting is transaction-local and there is no SET/SET SESSION of app.*", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/set_config\(\s*'app\.[a-z_]+'\s*,[^;]*?,\s*(true|false)\s*\)/g)) {
        if (m[1] !== "true") offenders.push(`${path.relative(process.cwd(), f)}: ${m[0]}`);
      }
      for (const m of src.matchAll(/\bSET\s+(SESSION\s+)?app\.[a-z_]+/gi)) offenders.push(`${path.relative(process.cwd(), f)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the detector itself flags a planted session-level setting (mutation check)", () => {
    const planted = "await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', false)`";
    const hits = [...planted.matchAll(/set_config\(\s*'app\.[a-z_]+'\s*,[^;]*?,\s*(true|false)\s*\)/g)].filter((m) => m[1] !== "true");
    expect(hits.length).toBe(1);
  });
});
