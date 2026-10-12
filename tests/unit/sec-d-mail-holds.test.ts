/**
 * Security lane D (9 Oct 2026) — SEC-091 mail delivery holds.
 *
 * The REAL lib/email.ts sendEmail and the REAL Resend SDK, pointed at the
 * campaign mail interceptor (scripts/readiness/release-verify.mjs
 * mail-interceptor, lane D port 4604) through RESEND_BASE_URL with a dummy key.
 * Positive control first: with EMAIL_DELIVERY=on a send REACHES the
 * interceptor (count +1), proving the counter would see a leak. Then every
 * hold: EMAIL_DELIVERY=off, a misconfigured value, a provisional recipient, a
 * failing recipient lookup, a recent bounce, and no API key — each must leave
 * the interceptor count unchanged. Nothing leaves 127.0.0.1. The database is a
 * recorder (EmailLog writes are asserted, not stored).
 *
 * The inventory test pins that lib/email.ts is the only place the Resend
 * client is constructed or api.resend.com is addressed, so every send boundary
 * in the app passes the holds above.
 */
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const db = vi.hoisted(() => ({ logs: [] as Array<Record<string, unknown>>, provisional: false, lookupThrows: false, bounced: false }));
vi.mock("@/lib/prisma-tenant", () => {
  const tx = {
    emailLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => { db.logs.push({ ...data }); return { id: `log_${db.logs.length}` }; },
      update: async ({ data }: { data: Record<string, unknown> }) => { db.logs[db.logs.length - 1] = { ...db.logs[db.logs.length - 1], ...data }; return {}; },
      findFirst: async () => (db.bounced ? { id: "b1", status: "bounced", createdAt: new Date() } : null),
    },
    user: {
      findFirst: async () => {
        if (db.lookupThrows) throw new Error("db down");
        return db.provisional ? { id: "u1", loginEmailProvisionalSince: new Date() } : null;
      },
    },
    tenant: { findUnique: async () => null },
  };
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  };
});

const PORT = 4604;
let child: ChildProcess | null = null;
const count = async () => ((await (await fetch(`http://127.0.0.1:${PORT}/__count`)).json()) as { count: number }).count;

beforeAll(async () => {
  child = spawn(process.execPath, ["scripts/readiness/release-verify.mjs", "mail-interceptor", "--port", String(PORT)], { stdio: ["ignore", "ignore", "pipe"] });
  for (let i = 0; i < 50; i++) {
    try { await count(); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("interceptor did not start");
}, 15_000);
afterAll(() => { child?.kill(); });

beforeEach(() => {
  db.logs = []; db.provisional = false; db.lookupThrows = false; db.bounced = false;
  process.env.RESEND_BASE_URL = `http://127.0.0.1:${PORT}`;
  process.env.RESEND_API_KEY = "re_secd_dummy_key_interceptor_only";
  process.env.EMAIL_DELIVERY = "on";
  vi.resetModules();
});

async function send() {
  const { sendEmail } = await import("@/lib/email");
  return sendEmail({ tenantId: "t_secd", templateId: "test", to: "secd-recipient@example.test", vars: { gymName: "secD Club" }, replyTo: "secd-reply@example.test" });
}

describe("SEC-091 every send boundary hold, with an interceptor positive control", () => {
  it("POSITIVE CONTROL: EMAIL_DELIVERY=on with a key → the send reaches the transport (interceptor count +1)", async () => {
    const before = await count();
    const r = await send();
    expect(await count()).toBe(before + 1);
    expect(r.ok).toBe(true);
    expect(db.logs.at(-1)?.status).toBe("sent");
  });

  const holds: Array<[string, () => void, string]> = [
    ["EMAIL_DELIVERY=off", () => { process.env.EMAIL_DELIVERY = "off"; }, "suppressed"],
    ["EMAIL_DELIVERY misconfigured ('false')", () => { process.env.EMAIL_DELIVERY = "false"; }, "suppressed"],
    ["recipient is a provisional login address", () => { db.provisional = true; }, "suppressed"],
    ["recipient lookup fails (DB error) → fail closed", () => { db.lookupThrows = true; }, "failed"],
    ["recipient bounced recently", () => { db.bounced = true; }, "failed"],
    ["no RESEND_API_KEY", () => { delete process.env.RESEND_API_KEY; }, "failed"],
  ];
  for (const [name, arrange, status] of holds) {
    it(`HOLD: ${name} → nothing reaches the transport; EmailLog ${status}`, async () => {
      arrange();
      const before = await count();
      const r = await send();
      expect(await count()).toBe(before);
      expect(r.ok).toBe(false);
      expect(db.logs.at(-1)?.status).toBe(status);
      expect(db.logs.some((l) => l.status === "sent")).toBe(false);
    });
  }
});

describe("SEC-091 inventory: lib/email.ts is the only mail transport", () => {
  it("no other app/lib/scripts file constructs a Resend client, imports 'resend', or addresses api.resend.com", () => {
    const ROOT = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules" && !name.startsWith(".")) walk(p); continue; }
        if (!/\.(ts|tsx|mjs|js|cjs)$/.test(name)) continue;
        const rel = path.relative(ROOT, p).split(path.sep).join("/");
        if (rel === "lib/email.ts") continue;
        const src = readFileSync(p, "utf8");
        if (/from\s+["']resend["']|require\(["']resend["']\)|new\s+Resend\(|api\.resend\.com\/emails/.test(src)) offenders.push(rel);
      }
    };
    for (const d of ["app", "lib", "components", "scripts"]) walk(path.join(ROOT, d));
    for (const f of ["auth.ts", "proxy.ts", "next.config.ts"]) {
      if (/from\s+["']resend["']|new\s+Resend\(|api\.resend\.com/.test(readFileSync(path.join(ROOT, f), "utf8"))) offenders.push(f);
    }
    // SEC-D-F3 FIXED 9 Oct 2026: scripts/test-resend.mjs (read the repo .env, i.e.
    // production keys, and sent through Resend directly without EMAIL_DELIVERY)
    // was deleted by the coordinator. lib/email.ts is the only transport; this
    // list can only stay empty.
    expect([...new Set(offenders)]).toEqual([]);
  });
});
