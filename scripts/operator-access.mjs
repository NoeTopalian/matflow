#!/usr/bin/env node
// Operator access — the ONLY emergency door to the operator console
// (operator auth hardening, 6 Oct 2026; docs/runbooks/OPERATOR-ACCESS-RECOVERY.md).
//
// There is no HTTP emergency path: MATFLOW_ADMIN_SECRET grants nothing in
// production. Whoever runs this needs direct database credentials, so it is
// exactly as strong as the database itself, and every run writes an audit row
// (AuditLog, tenantId NULL, metadata.via = "local-script") naming the operator,
// the action, the reason and the machine user who ran it.
//
// Usage (from the matflow root):
//   DATABASE_URL=<url> node scripts/operator-access.mjs <command> --email <addr> --reason "<why>" --confirm-host <endpoint>
//
//   create   --name "<name>"   new operator, generated password, NO authenticator
//                               (enrols at first sign-in, which is mandatory)
//                               + a one-time ENROLMENT TICKET (30 minutes)
//   recover                    new password + authenticator cleared + every
//                               session and step-up grant revoked (lost phone,
//                               suspected compromise) + a one-time ENROLMENT
//                               TICKET. Re-enrol at next sign-in.
//   revoke                     every session and step-up grant revoked; nothing else
//   list                       operators and whether each has an authenticator
//
// Safety:
//   - Does NOT read .env. DATABASE_URL must be set in the environment for this
//     one command, on purpose.
//   - --confirm-host must be a substring of the DATABASE_URL host (e.g. the Neon
//     endpoint id), so a URL left in the shell cannot be hit by accident.
//   - Passwords are generated (24 chars) and printed once; or supplied via
//     OPERATOR_PASSWORD (min 12 chars, not printed).
//   - Never prints the DATABASE_URL, a TOTP secret or a hash.
//   - Enrolment ticket (review finding D3, 6 Oct 2026): the password alone no
//     longer enrols an authenticator. create/recover print a one-time ticket
//     (shown once, never logged, never written to the audit row); only its
//     SHA-256 and a 30-minute expiry are stored on the Operator row, and the
//     enrolment that uses it clears them. Generation and hashing must match
//     lib/operator-auth.ts newOperatorEnrolmentTicket / hashOperatorEnrolmentTicket.
//   - Each change and its audit row commit in ONE transaction (review finding
//     D8): no change without its record, no record without its change.

import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function fail(msg) {
  console.error(`operator-access: ${msg}`);
  process.exit(1);
}

const command = process.argv[2];
if (!["create", "recover", "revoke", "list"].includes(command ?? "")) {
  fail("command must be one of: create, recover, revoke, list (see the header of this file)");
}

const url = process.env.DATABASE_URL;
if (!url) fail("DATABASE_URL must be set in the environment for this command (this script never reads .env)");
let host;
try { host = new URL(url).hostname; } catch { fail("DATABASE_URL is not a valid URL"); }
const confirmHost = arg("confirm-host");
if (!confirmHost || !host.includes(confirmHost)) {
  fail("--confirm-host must name the database you mean (a substring of the DATABASE_URL host, e.g. the Neon endpoint id)");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const ranBy = `${os.userInfo().username}@${os.hostname()}`;

/**
 * The change and its audit row in ONE transaction (review finding D8): `change`
 * runs with the transaction client and returns the operator id the row is
 * about. Platform event: no tenant, written under the RLS bypass as
 * lib/audit-log.ts does for tenantId-null rows.
 */
async function changeWithAudit(action, reason, change) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const operatorId = await change(tx);
    await tx.auditLog.create({
      data: {
        tenantId: null,
        userId: null,
        action,
        entityType: "Operator",
        entityId: operatorId,
        metadata: { reason, via: "local-script", ranBy, actingAs: operatorId },
      },
    });
    return operatorId;
  });
}

/** 32 hex chars in groups of four; stored as SHA-256 of the bare hex (lib/operator-auth.ts). */
function newEnrolmentTicket() {
  const hex = randomBytes(16).toString("hex");
  return {
    ticket: hex.match(/.{4}/g).join("-"),
    hash: createHash("sha256").update(hex).digest("hex"),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  };
}

function newPassword() {
  const supplied = process.env.OPERATOR_PASSWORD;
  if (supplied !== undefined) {
    if (supplied.length < 12) fail("OPERATOR_PASSWORD must be at least 12 characters");
    return { password: supplied, printed: false };
  }
  return { password: randomBytes(18).toString("base64").replace(/[+/=]/g, "").slice(0, 24), printed: true };
}

try {
  if (command === "list") {
    const ops = await prisma.operator.findMany({
      select: { email: true, name: true, role: true, totpEnabled: true, lastLoginAt: true, lockedUntil: true },
      orderBy: { createdAt: "asc" },
    });
    for (const o of ops) {
      console.log(`${o.email}  ${o.name}  role=${o.role}  authenticator=${o.totpEnabled ? "yes" : "NO"}  lastLogin=${o.lastLoginAt?.toISOString() ?? "never"}${o.lockedUntil && o.lockedUntil > new Date() ? "  LOCKED" : ""}`);
    }
    if (ops.length === 0) console.log("(no operators)");
    process.exit(0);
  }

  const email = (arg("email") ?? "").trim().toLowerCase();
  const reason = (arg("reason") ?? "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("--email <address> is required");
  if (reason.length < 5) fail('--reason "<why>" is required (at least 5 characters)');

  const existing = await prisma.operator.findUnique({ where: { email }, select: { id: true } });

  if (command === "create") {
    if (existing) fail("that operator already exists; use recover to replace their password and authenticator");
    const name = (arg("name") ?? "").trim();
    if (!name) fail('--name "<name>" is required for create');
    const { password, printed } = newPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const t = newEnrolmentTicket();
    await changeWithAudit("admin.operator.created", reason, async (tx) => {
      const op = await tx.operator.create({
        data: {
          email, name, passwordHash, role: "super_admin",
          enrolmentTicketHash: t.hash, enrolmentTicketExpiresAt: t.expiresAt,
        },
        select: { id: true },
      });
      return op.id;
    });
    console.log(`Created operator ${email}.`);
    console.log(printed ? `Password (shown once, save it now): ${password}` : "Password: as supplied in OPERATOR_PASSWORD (not printed).");
    console.log(`Enrolment ticket (shown once, works once, expires ${t.expiresAt.toISOString()}): ${t.ticket}`);
    console.log("Next: sign in at /admin/login within 30 minutes, enter the ticket, and set up the authenticator. Without the ticket the password cannot enrol one; run recover for a new ticket if it expires.");
  } else if (command === "recover") {
    if (!existing) fail("no operator with that email");
    const { password, printed } = newPassword();
    const passwordHash = await bcrypt.hash(password, 12);
    const t = newEnrolmentTicket();
    await changeWithAudit("admin.operator.recovered", reason, async (tx) => {
      await tx.operator.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          totpEnabled: false,
          totpSecret: null,
          totpLastUsedStep: null,
          stepUpNonceHash: null,
          stepUpExpiresAt: null,
          supportNonceHash: null,
          supportExpiresAt: null,
          enrolmentTicketHash: t.hash,
          enrolmentTicketExpiresAt: t.expiresAt,
          failedLoginCount: 0,
          lockedUntil: null,
          sessionVersion: { increment: 1 },
        },
      });
      return existing.id;
    });
    console.log(`Recovered operator ${email}: password replaced, authenticator cleared, every session revoked.`);
    console.log(printed ? `Password (shown once, save it now): ${password}` : "Password: as supplied in OPERATOR_PASSWORD (not printed).");
    console.log(`Enrolment ticket (shown once, works once, expires ${t.expiresAt.toISOString()}): ${t.ticket}`);
    console.log("Next: sign in at /admin/login within 30 minutes, enter the ticket, and enrol the new authenticator.");
  } else if (command === "revoke") {
    if (!existing) fail("no operator with that email");
    await changeWithAudit("admin.operator.sessions_revoked", reason, async (tx) => {
      await tx.operator.update({
        where: { id: existing.id },
        data: { sessionVersion: { increment: 1 }, stepUpNonceHash: null, stepUpExpiresAt: null, supportNonceHash: null, supportExpiresAt: null },
      });
      return existing.id;
    });
    console.log(`Every session and step-up grant of ${email} is revoked.`);
  }
} finally {
  await prisma.$disconnect();
}
