// Shared fixtures for the operator-hub database suites (TEST branch only).
//
// Extracted from tests/integration/operator-hub-conflict-db.test.ts (hub
// conflicts, 12 Oct 2026) so every hub suite builds the same synthetic club,
// operator session and step-up grants. Everything is run-stamped (STAMP) and
// removed by cleanup(); nothing here reads or prints a connection string.
//
// The suites that use this module must mock next/headers (cookie jar) and
// @/auth (staff session) themselves, reading tests/integration/helpers/
// operator-hub-state.ts — vi.mock belongs in the test file. The operator
// session cookie is put in that jar the first time a club is made.

import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { issueOperatorSession } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, type StepUpAction } from "@/lib/operator-step-up";
import { POST as checkRoute } from "@/app/api/admin/customers/[id]/login-email/check/route";
import { hubState } from "./operator-hub-state";

export const STAMP = `hub${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const OP_ID = `lane-f-op-${STAMP}`;
export const ORIGIN = "http://localhost:3847";
/** A run-stamped synthetic address. */
export const stampedEmail = (who: string) => `${STAMP}-${who}@example.test`;

const created = { tenants: [] as string[], slugs: new Map<string, string>(), operator: false };

/** A same-origin JSON POST, as the browser console sends it. */
export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

/** An operator console request; the step-up grant (if any) travels in its header. */
export function operatorRequest(body: unknown, grant?: string, url = "/api/admin/hub-test"): Request {
  return jsonRequest(url, body, grant ? { [STEP_UP_HEADER]: grant } : {});
}

export async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}

/** The synthetic MFA operator, created once per run; its session cookie goes in the jar. */
export async function ensureOperator(): Promise<string> {
  if (!created.operator) {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `lane-f-${STAMP}@operator.test`,
        name: "Lane F synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    created.operator = true;
    hubState.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 0));
  }
  return OP_ID;
}

/** A run-stamped club; `roleLabel` only names it. Returns the tenant id. */
export async function makeTenant(roleLabel: string): Promise<string> {
  await ensureOperator();
  const n = created.tenants.length + 1;
  const slug = `${STAMP}-${n}`;
  const t = await withRlsBypass((tx) =>
    tx.tenant.create({ data: { name: `${STAMP} ${roleLabel} club ${n}`, slug, onboardingCompleted: true }, select: { id: true } }),
  );
  created.tenants.push(t.id);
  created.slugs.set(t.id, slug);
  return t.id;
}

export const tenantSlug = (tenantId: string) => created.slugs.get(tenantId) ?? "";

type OwnerExtra = Partial<{ name: string; passwordHash: string; totpEnabled: boolean; totpSecret: string; totpRecoveryCodes: string[] }>;
export async function makeOwner(tenantId: string, email: string, extra: OwnerExtra = {}): Promise<string> {
  const u = await withRlsBypass((tx) =>
    tx.user.create({
      data: { tenantId, email, name: "Synthetic Owner", role: "owner", passwordHash: "owner-hash-unchanged", ...extra },
      select: { id: true },
    }),
  );
  return u.id;
}

/**
 * A non-owner staff account. Staff rows always carry a password hash in this
 * schema (`User.passwordHash` is NOT NULL), so there is no "without password"
 * shape to build.
 */
export async function makeStaff(
  tenantId: string,
  opts: { email: string; role: "manager" | "coach" | "admin"; name?: string },
): Promise<string> {
  const u = await withRlsBypass((tx) =>
    tx.user.create({
      data: {
        tenantId,
        email: opts.email,
        name: opts.name ?? `Synthetic ${opts.role}`,
        role: opts.role,
        passwordHash: "staff-hash-unchanged",
      },
      select: { id: true },
    }),
  );
  return u.id;
}

export async function makeMember(
  tenantId: string,
  opts: { email: string; name?: string; externalRef?: string; passwordHash?: string },
): Promise<string> {
  const m = await withRlsBypass((tx) =>
    tx.member.create({
      data: {
        tenantId,
        email: opts.email,
        name: opts.name ?? "Synthetic Member",
        ...(opts.externalRef ? { externalRef: opts.externalRef } : {}),
        ...(opts.passwordHash ? { passwordHash: opts.passwordHash } : {}),
      },
      select: { id: true },
    }),
  );
  return m.id;
}

/** A step-up grant for the synthetic operator (its version is read now). */
export async function issueGrant(action: StepUpAction, target: string, change: unknown): Promise<string> {
  return (await issueStepUpGrant({ operatorId: OP_ID, action, targetId: target, change })).grant;
}

/** POST …/login-email/check as the operator; the raw response. */
export async function checkResponse(tenantId: string, email: string): Promise<Response> {
  return checkRoute(jsonRequest(`/api/admin/customers/${tenantId}/login-email/check`, { email }), {
    params: Promise.resolve({ id: tenantId }),
  });
}

type CheckedJson = { kind: string; id?: string; name?: string; status?: string; version?: string; count?: number };
export type CheckJson = {
  ok?: boolean;
  free: boolean;
  sameAsOwner?: boolean;
  holder: CheckedJson & { holders?: CheckedJson[] };
  tenant: { id: string; name: string };
  owner: { id: string; name: string };
};
/** POST …/login-email/check as the operator; the JSON answer. */
export async function checkAddress(tenantId: string, email: string): Promise<CheckJson> {
  return (await (await checkResponse(tenantId, email)).json()) as CheckJson;
}

/** users.sessionVersion += 1 (the record "changed since the check"). */
export async function bumpSessionVersion(userId: string): Promise<void> {
  await withRlsBypass((tx) => tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }));
}

/**
 * The legacy shape the login-identity lock now prevents: a member AND a staff
 * account on one canonical address (mixed case), written straight past the
 * claim. Returns both ids.
 */
export async function seedDuplicate(tenantId: string, email: string): Promise<{ memberId: string; userId: string }> {
  return withRlsBypass(async (tx) => {
    const m = await tx.member.create({ data: { tenantId, email: email.toUpperCase(), name: "Legacy Duplicate Member" }, select: { id: true } });
    const u = await tx.user.create({
      data: { tenantId, email, name: "Legacy Duplicate Coach", role: "coach", passwordHash: "staff-hash-unchanged" },
      select: { id: true },
    });
    return { memberId: m.id, userId: u.id };
  });
}

type Purpose = "reset" | "login" | "first_time_signup" | "waiver_open";
/** An email-bound token in this club; `raw` is the secret a person would hold. */
export async function mint(tenantId: string, email: string, purpose: Purpose) {
  const raw = purpose === "reset" ? randomBytes(8).toString("hex") : randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const row = await withRlsBypass((tx) =>
    purpose === "reset"
      ? tx.passwordResetToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), expiresAt }, select: { id: true } })
      : tx.magicLinkToken.create({ data: { tenantId, email, tokenHash: hashToken(raw), purpose, expiresAt }, select: { id: true } }),
  );
  return { id: row.id, raw, purpose };
}
export type Minted = Awaited<ReturnType<typeof mint>>;
export const isUsed = (t: Minted) =>
  withRlsBypass(async (tx) =>
    t.purpose === "reset"
      ? (await tx.passwordResetToken.findUniqueOrThrow({ where: { id: t.id } })).used
      : (await tx.magicLinkToken.findUniqueOrThrow({ where: { id: t.id } })).used,
  );

/** Delete every club, row and the operator this run created; throws if anything is left. */
export async function cleanup(): Promise<void> {
  await new Promise((r) => setTimeout(r, 750)); // best-effort refusal rows land first
  const tenants = [...created.tenants];
  for (const tenantId of tenants) {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.magicLinkToken.deleteMany({ where: { tenantId } });
      await tx.passwordResetToken.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  if (created.operator) {
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { id: { in: tenants } } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: tenants } } }),
    operator: await tx.operator.count({ where: { id: OP_ID } }),
  }));
  created.tenants = [];
  created.slugs.clear();
  created.operator = false;
  if (left.tenants || left.audit || left.operator) throw new Error(`cleanup left rows behind: ${JSON.stringify(left)}`);
}
