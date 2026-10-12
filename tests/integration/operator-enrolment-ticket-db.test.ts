// Operator enrolment ticket against REAL Postgres (lane H, 6 Oct 2026 —
// review findings D3 and D8).
//
// Runs the real scripts/operator-access.mjs (create, then recover) against the
// database in DATABASE_URL — the Neon TEST branch only (tests/setup-test-db.ts
// refuses the production endpoint) — and proves:
//   - the printed ticket's hash is what lib/operator-auth.ts computes, and only
//     the hash + a 30-minute expiry are stored; the audit row carries neither;
//   - the enabling write the setup route uses is conditional on the ticket:
//     wrong ticket → 0 rows, right ticket → 1, the same ticket again → 0, and
//     five concurrent enabling writes → exactly 1;
//   - recover issues a fresh ticket and the old one is dead.
// One synthetic Operator row with a unique email; it and its audit rows are
// deleted in afterAll. Skips without a database.

import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashOperatorEnrolmentTicket } from "@/lib/operator-auth";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const EMAIL = `lane-h-${STAMP}@operator.test`;

function script(...args: string[]): { status: number | null; ticket: string | null } {
  const host = new URL(process.env.DATABASE_URL!).hostname;
  const r = spawnSync(process.execPath, ["scripts/operator-access.mjs", ...args, "--confirm-host", host], {
    encoding: "utf8",
    env: { ...process.env, OPERATOR_PASSWORD: `lane-h-password-${STAMP}` },
  });
  const line = (r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("Enrolment ticket")) ?? "";
  const ticket = line.match(/([0-9a-f]{4}(?:-[0-9a-f]{4}){7})\s*$/)?.[1] ?? null;
  return { status: r.status, ticket };
}

/** The setup route's enabling write (app/api/admin/auth/operator-totp/setup). */
function enable(id: string, ticket: string) {
  return prisma.operator.updateMany({
    where: {
      id,
      totpEnabled: false,
      enrolmentTicketHash: hashOperatorEnrolmentTicket(ticket),
      enrolmentTicketExpiresAt: { gt: new Date() },
    },
    data: { totpEnabled: true, sessionVersion: { increment: 1 }, enrolmentTicketHash: null, enrolmentTicketExpiresAt: null },
  });
}

let opId: string | null = null;

describe.skipIf(!HAS_DB)("operator enrolment ticket on the database", () => {
  afterAll(async () => {
    // Every synthetic row this file has created (an earlier failed run included).
    const rows = await prisma.operator.findMany({
      where: { email: { startsWith: "lane-h-", endsWith: "@operator.test" } },
      select: { id: true },
    });
    for (const { id } of rows) {
      await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { entityType: "Operator", entityId: id } }));
      await prisma.operator.deleteMany({ where: { id } });
    }
  });

  it("create: prints a ticket, stores only its hash + 30-minute expiry, audit row in the same run", async () => {
    const before = Date.now();
    const r = script("create", "--email", EMAIL, "--name", "Lane H synthetic operator", "--reason", "lane H ticket test");
    expect(r.status).toBe(0);
    expect(r.ticket).toBeTruthy();
    const row = await prisma.operator.findUnique({
      where: { email: EMAIL },
      select: { id: true, totpEnabled: true, enrolmentTicketHash: true, enrolmentTicketExpiresAt: true },
    });
    opId = row!.id;
    expect(row!.totpEnabled).toBe(false);
    expect(row!.enrolmentTicketHash).toBe(hashOperatorEnrolmentTicket(r.ticket));
    const ttl = row!.enrolmentTicketExpiresAt!.getTime() - before;
    expect(ttl).toBeGreaterThan(29 * 60 * 1000);
    expect(ttl).toBeLessThan(31 * 60 * 1000);

    const audit = await withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { entityType: "Operator", entityId: row!.id }, select: { action: true, metadata: true } }),
    );
    expect(audit.map((a) => a.action)).toEqual(["admin.operator.created"]);
    const meta = JSON.stringify(audit[0].metadata);
    expect(meta).not.toContain(r.ticket!);
    expect(meta).not.toContain(row!.enrolmentTicketHash!);
  });

  it("recover: a fresh ticket replaces the old one; the old ticket cannot enable", async () => {
    const first = await prisma.operator.findUnique({ where: { email: EMAIL }, select: { enrolmentTicketHash: true } });
    const r = script("recover", "--email", EMAIL, "--reason", "lane H ticket test");
    expect(r.status).toBe(0);
    const row = await prisma.operator.findUnique({
      where: { email: EMAIL },
      select: { id: true, enrolmentTicketHash: true },
    });
    expect(row!.enrolmentTicketHash).not.toBe(first!.enrolmentTicketHash);
    expect(row!.enrolmentTicketHash).toBe(hashOperatorEnrolmentTicket(r.ticket));
    const actions = await withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { entityType: "Operator", entityId: row!.id }, select: { action: true } }),
    );
    expect(actions.map((a) => a.action).sort()).toEqual(["admin.operator.created", "admin.operator.recovered"]);
  });

  it("the enabling write: wrong ticket 0, five concurrent right-ticket writes exactly 1, reuse 0", async () => {
    const r = script("recover", "--email", EMAIL, "--reason", "lane H ticket test");
    expect(r.status).toBe(0);
    const id = opId!;
    const wrong = "0000-1111-2222-3333-4444-5555-6666-7777";
    expect((await enable(id, wrong)).count).toBe(0);

    const results = await Promise.all(Array.from({ length: 5 }, () => enable(id, r.ticket!)));
    expect(results.filter((x) => x.count === 1)).toHaveLength(1);

    // Reused after it was consumed (authenticator cleared again WITHOUT a new ticket).
    await prisma.operator.update({ where: { id }, data: { totpEnabled: false } });
    expect((await enable(id, r.ticket!)).count).toBe(0);
  });

  it("an expired ticket cannot enable", async () => {
    const r = script("recover", "--email", EMAIL, "--reason", "lane H ticket test");
    expect(r.status).toBe(0);
    await prisma.operator.update({ where: { id: opId! }, data: { enrolmentTicketExpiresAt: new Date(Date.now() - 1000) } });
    expect((await enable(opId!, r.ticket!)).count).toBe(0);
  });
});
