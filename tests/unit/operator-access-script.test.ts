// scripts/operator-access.mjs (lane H, 6 Oct 2026) — review findings D3 and D8.
//
//   D3: create / recover print a one-time enrolment ticket and store only its
//       SHA-256 + a 30-minute expiry; the ticket never reaches the audit row.
//       Its hash must match lib/operator-auth.ts (the route that accepts it).
//   D8: each change and its audit row commit in ONE transaction — the change is
//       made with the transaction client, never the top-level client.
//
// Drives the real script with @prisma/client mocked. The real-database run is
// tests/integration/operator-enrolment-ticket-db.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { hashOperatorEnrolmentTicket } from "@/lib/operator-auth";

const h = vi.hoisted(() => ({
  calls: [] as string[],
  failAudit: false,
  existing: null as null | { id: string },
  created: null as null | { data: Record<string, unknown> },
  updated: null as null | { data: Record<string, unknown> },
  audit: null as null | { data: Record<string, unknown> },
}));

vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class {} }));
vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    operator = {
      findUnique: async () => h.existing,
      create: async () => { h.calls.push("TOP-LEVEL operator.create"); return { id: "op-new" }; },
      update: async () => { h.calls.push("TOP-LEVEL operator.update"); return {}; },
    };
    auditLog = { create: async () => { h.calls.push("TOP-LEVEL auditLog.create"); return {}; } };
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      h.calls.push("$transaction");
      const tx = {
        $executeRaw: async () => 0,
        operator: {
          create: async (a: { data: Record<string, unknown> }) => { h.calls.push("tx.operator.create"); h.created = a; return { id: "op-new" }; },
          update: async (a: { data: Record<string, unknown> }) => { h.calls.push("tx.operator.update"); h.updated = a; return {}; },
        },
        auditLog: {
          create: async (a: { data: Record<string, unknown> }) => {
            if (h.failAudit) throw new Error("audit store unavailable");
            h.calls.push("tx.auditLog.create");
            h.audit = a;
            return {};
          },
        },
      };
      return fn(tx);
    }
    async $disconnect() {}
  },
}));

const out: string[] = [];
const savedArgv = process.argv;
const savedUrl = process.env.DATABASE_URL;

async function run(...args: string[]) {
  vi.resetModules();
  process.argv = ["node", "operator-access.mjs", ...args, "--confirm-host", "db.example"];
  return import("../../scripts/operator-access.mjs");
}

const printedTicket = () => {
  const line = out.find((l) => l.startsWith("Enrolment ticket"));
  return line?.match(/([0-9a-f]{4}(?:-[0-9a-f]{4}){7})$/)?.[1];
};

beforeEach(() => {
  h.calls.length = 0;
  h.failAudit = false;
  h.existing = null;
  h.created = h.updated = h.audit = null;
  out.length = 0;
  process.env.DATABASE_URL = "postgresql://user:pw@db.example/neondb";
  process.env.OPERATOR_PASSWORD = "a-supplied-operator-password";
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
});
afterEach(() => {
  process.argv = savedArgv;
  if (savedUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedUrl;
  delete process.env.OPERATOR_PASSWORD;
  vi.restoreAllMocks();
});

describe("create", () => {
  it("D3: prints a ticket once, stores only its SHA-256 and a 30-minute expiry", async () => {
    const before = Date.now();
    await run("create", "--email", "new-op@example.test", "--name", "New Op", "--reason", "lane H test");
    const ticket = printedTicket();
    expect(ticket, "a ticket is printed").toBeTruthy();
    expect(out.filter((l) => l.includes(ticket!))).toHaveLength(1);
    const data = h.created!.data;
    expect(data.enrolmentTicketHash).toBe(createHash("sha256").update(ticket!.replace(/-/g, "")).digest("hex"));
    expect(data.enrolmentTicketHash, "same hash the enrolment route computes").toBe(hashOperatorEnrolmentTicket(ticket));
    const exp = (data.enrolmentTicketExpiresAt as Date).getTime();
    expect(exp - before).toBeGreaterThanOrEqual(30 * 60 * 1000 - 5000);
    expect(exp - before).toBeLessThanOrEqual(30 * 60 * 1000 + 5000);
    expect(JSON.stringify(data)).not.toContain(ticket!);
  });

  it("D3: the ticket and its hash never reach the audit row", async () => {
    await run("create", "--email", "new-op@example.test", "--name", "New Op", "--reason", "lane H test");
    const ticket = printedTicket()!;
    const row = JSON.stringify(h.audit);
    expect(row).not.toContain(ticket);
    expect(row).not.toContain(ticket.replace(/-/g, ""));
    expect(row).not.toContain(String(h.created!.data.enrolmentTicketHash));
  });

  it("D8: the operator row and its audit row are written in ONE transaction", async () => {
    await run("create", "--email", "new-op@example.test", "--name", "New Op", "--reason", "lane H test");
    expect(h.calls).toEqual(["$transaction", "tx.operator.create", "tx.auditLog.create"]);
  });

  it("D8: if the audit row fails the whole create fails (nothing outside the transaction), and no ticket is printed", async () => {
    h.failAudit = true;
    await expect(run("create", "--email", "new-op@example.test", "--name", "New Op", "--reason", "lane H test")).rejects.toThrow(/audit/);
    expect(h.calls.filter((c) => c.startsWith("TOP-LEVEL"))).toEqual([]);
    expect(printedTicket()).toBeUndefined();
  });
});

describe("recover", () => {
  it("D3 + D8: clears the authenticator, issues a fresh ticket, audit in the same transaction", async () => {
    h.existing = { id: "op-1" };
    await run("recover", "--email", "op@example.test", "--reason", "lost phone, verified");
    expect(h.calls).toEqual(["$transaction", "tx.operator.update", "tx.auditLog.create"]);
    const data = h.updated!.data;
    expect(data).toMatchObject({ totpEnabled: false, totpSecret: null });
    expect(data.enrolmentTicketHash).toBe(hashOperatorEnrolmentTicket(printedTicket()));
    expect(h.audit!.data).toMatchObject({ action: "admin.operator.recovered", entityId: "op-1" });
  });
});

describe("revoke", () => {
  it("D8: the revocation and its audit row are one transaction", async () => {
    h.existing = { id: "op-1" };
    await run("revoke", "--email", "op@example.test", "--reason", "suspected compromise");
    expect(h.calls).toEqual(["$transaction", "tx.operator.update", "tx.auditLog.create"]);
    expect(printedTicket()).toBeUndefined();
  });

  it("E2E follow-up (lane I): clears the support nonce and the step-up grant, as recover does", async () => {
    h.existing = { id: "op-1" };
    await run("revoke", "--email", "op@example.test", "--reason", "suspected compromise");
    expect(h.updated!.data).toMatchObject({
      sessionVersion: { increment: 1 },
      supportNonceHash: null,
      supportExpiresAt: null,
      stepUpNonceHash: null,
      stepUpExpiresAt: null,
    });
    // Revoke is sessions only: the authenticator and password stay.
    expect(h.updated!.data).not.toHaveProperty("totpEnabled");
    expect(h.updated!.data).not.toHaveProperty("passwordHash");
  });
});
