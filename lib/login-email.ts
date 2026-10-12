/**
 * Login email: provisional identifier vs verified mailbox (7 Oct 2026).
 *
 * A staff login email is two things at once — the identifier typed at sign-in
 * and, normally, a mailbox the person controls. For the first real club owner
 * those two came apart: MatFlow was given an address to sign him in with, and
 * nobody has shown that he reads it. While `User.loginEmailProvisionalSince`
 * is set the address is the IDENTIFIER ONLY:
 *
 *   - forgot-password and magic-link request mint and send nothing, and answer
 *     exactly as for an unknown address;
 *   - magic-link verify and reset-password refuse any token for the account;
 *   - Google (or any external identity provider) sign-in is refused;
 *   - password + authenticator sign-in is unaffected.
 *
 * Mail-dark lane (M) also calls `isLoginEmailProvisional` before sending
 * anything to a staff address.
 *
 * Set by: the operator ("mark provisional", "change login email") and the
 * owner's own change (there is no verification flow yet, so a new address is
 * provisional too). Cleared by: an operator attestation only — see
 * docs/runbooks/OWNER-LOGIN-EMAIL-CHANGE.md.
 */
import { createHash, createHmac } from "node:crypto";
import { verifySync } from "otplib";
import type { Prisma } from "@prisma/client";
import { normaliseEmail } from "@/lib/email-normalise";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

/** True when the row's login email is a provisional identifier, not a verified mailbox. */
export function isLoginEmailProvisional(
  user: { loginEmailProvisionalSince?: Date | string | null } | null | undefined,
): boolean {
  return user?.loginEmailProvisionalSince != null;
}

/**
 * KEYED digest of the normalised address, for audit rows that must not hold
 * the address (admin hub AH-E2, 9 Oct 2026). HMAC-SHA256 under the server
 * secret with a domain prefix, the way lib/operator-step-up keys its change
 * digest: a plain SHA-256 of a predictable address is not anonymisation —
 * anyone with a candidate list can hash it and match. Same input + same key
 * → same digest, so two audit rows about one address still line up. (Audit
 * field names such as `oldEmailSha256` are kept for continuity; rows written
 * before this change hold the old unkeyed form.)
 */
export function emailDigest(email: string, key: string = digestKey()): string {
  return createHmac("sha256", key).update(`login-email-digest:v1:${email.trim().toLowerCase()}`).digest("hex");
}

/**
 * The same secret as lib/auth-secret's AUTH_SECRET_VALUE (NEXTAUTH_SECRET,
 * then AUTH_SECRET), read when a digest is made rather than imported: that
 * module throws at IMPORT in production without a secret, and this module is
 * imported by sign-in doors (forgot-password, magic link) only for the
 * provisional check — a digest-free import must not fail with them. A digest
 * is still refused under an empty key in production.
 */
function digestKey(): string {
  const key = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
  if (!key && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
    throw new Error("NEXTAUTH_SECRET or AUTH_SECRET must be set in production — refusing an unkeyed email digest");
  }
  return key;
}

/** Audit reason minimum for operator login-email actions. */
export const LOGIN_EMAIL_REASON_MIN = 10;

// ── Login identity claims (admin hub AH-01, 9 Oct 2026) ─────────────────────
//
// A login address is ONE identity per club across two tables: auth.ts
// resolves the club, then looks the address up in User and in Member, and a
// User row wins. `User.email` and `Member.email` each carry their own
// `@@unique([tenantId, email])`, but two separate unique indexes do not make
// the pair unique: a staff writer and a member writer that each checked the
// other table saw nothing (the other side was not yet committed) and both
// committed — reproduced with two connections in
// tests/integration/login-identity-race-db.test.ts.
//
// The protection is a transaction-scoped advisory lock on (club, canonical
// address), taken by EVERY writer of a login address before its lookup and
// its write, inside its own transaction. Transaction-scoped, so it is released
// at commit/rollback and is safe behind the Neon transaction pooler; available
// to the restricted `matflow_app` role. It is enforceable only while every
// writer participates — tests/unit/login-identity-writers.test.ts fails the
// build when a new User/Member email write appears without a claim.
//
// Canonical address: trim + lower-case (lib/email-normalise). Plus tags and
// dots are NOT stripped — they are different mailboxes at many providers.

/**
 * A transaction client and NOT the bare singleton: the advisory lock is
 * transaction-scoped, so a claim made outside a transaction would be released
 * before the write it is meant to protect. `PrismaClient` has `$transaction`;
 * an interactive transaction client does not — so passing `prisma` here does
 * not compile.
 */
export type LoginClaimTx = Prisma.TransactionClient & { $transaction?: never };

/** One row that holds a login address. */
export type LoginIdentityHolder =
  | {
      kind: "user";
      id: string;
      name: string;
      role: string;
      /** Staff rows always carry a password and are reachable by reset/magic link. */
      canSignIn: true;
    }
  | {
      kind: "member";
      id: string;
      name: string;
      status: string;
      hasPassword: boolean;
      /**
       * Conservative: true unless the address is one no person can ever
       * receive (synthesised no-login or erased sentinel). A null password is
       * NOT "cannot sign in" — invite/activation, magic link and reset all
       * reach a passwordless member through the address.
       */
      canSignIn: boolean;
    };

/**
 * The holders of an address in one club, after exclusions. `many` is a
 * legacy inconsistency (two rows on one canonical address — mixed case,
 * whitespace, or a cross-table duplicate written before this lock) and is
 * never resolved by picking one.
 */
export type LoginIdentityClaim =
  | { kind: "none" }
  | LoginIdentityHolder
  | { kind: "many"; holders: LoginIdentityHolder[] };

/** Thrown inside a writer's transaction when the address is held; mapped to an opaque 409. */
export class LoginIdentityTaken extends Error {
  constructor(public readonly claim: Exclude<LoginIdentityClaim, { kind: "none" }>) {
    super("login identity taken");
    this.name = "LoginIdentityTaken";
  }
}

// Advisory-lock namespace (first key of the two-key form), so these locks can
// never meet another feature's advisory lock. ASCII "LGID".
const LOGIN_IDENTITY_LOCK_NS = 0x4c474944;

function canonical(email: string): string {
  return normaliseEmail(email);
}

/** Second lock key: 32 bits of SHA-256 over "tenantId:canonical address". */
function lockKey(tenantId: string, email: string): number {
  return createHash("sha256").update(`${tenantId}:${email}`).digest().readInt32BE(0);
}

/**
 * Take the locks in ascending key order so two writers that each need several
 * (a bulk import slice and another slice) cannot deadlock. Held until the
 * transaction ends.
 */
async function lockLoginKeys(tx: LoginClaimTx, keys: number[]): Promise<void> {
  for (const k of [...new Set(keys)].sort((a, b) => a - b)) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOGIN_IDENTITY_LOCK_NS}::int4, ${k}::int4)`;
  }
}

const ERASED_SENTINEL = /^deleted-.*@deleted\.invalid$/i;

/**
 * Every row in this club holding any of these canonical addresses, matched on
 * the canonical form of the STORED value too (a legacy row written before
 * normalise-on-write still collides). Keyed by canonical address.
 */
async function findLoginHolders(
  tx: LoginClaimTx,
  tenantId: string,
  emails: string[],
): Promise<Map<string, LoginIdentityHolder[]>> {
  const out = new Map<string, LoginIdentityHolder[]>();
  if (emails.length === 0) return out;
  const [users, members] = await Promise.all([
    tx.$queryRaw<Array<{ id: string; name: string; role: string; key: string }>>`
      SELECT "id", "name", "role", lower(btrim("email")) AS "key"
      FROM "User"
      WHERE "tenantId" = ${tenantId} AND lower(btrim("email")) = ANY(${emails}::text[])
      ORDER BY "id"`,
    tx.$queryRaw<Array<{ id: string; name: string; status: string; hasPassword: boolean; email: string; key: string }>>`
      SELECT "id", "name", "status", ("passwordHash" IS NOT NULL) AS "hasPassword", "email", lower(btrim("email")) AS "key"
      FROM "Member"
      WHERE "tenantId" = ${tenantId} AND lower(btrim("email")) = ANY(${emails}::text[])
      ORDER BY "id"`,
  ]);
  const push = (key: string, h: LoginIdentityHolder) => {
    const list = out.get(key);
    if (list) list.push(h);
    else out.set(key, [h]);
  };
  for (const u of users) push(u.key, { kind: "user", id: u.id, name: u.name, role: u.role, canSignIn: true });
  for (const m of members) {
    push(m.key, {
      kind: "member",
      id: m.id,
      name: m.name,
      status: m.status,
      hasPassword: m.hasPassword === true,
      canSignIn: !isSynthesisedEmail(m.email) && !ERASED_SENTINEL.test(m.email),
    });
  }
  return out;
}

function toClaim(holders: LoginIdentityHolder[]): LoginIdentityClaim {
  if (holders.length === 0) return { kind: "none" };
  if (holders.length === 1) return holders[0];
  return { kind: "many", holders };
}

/**
 * Claim `email` as a login address in `tenantId` for the calling writer, and
 * say who already holds it. Call INSIDE the writer's own transaction, BEFORE
 * its write; the lock is held until that transaction ends, so a concurrent
 * writer of the same address (either table) waits and then sees this one's
 * row. `exclude` names the record being re-saved (its own address is not a
 * collision). The caller decides; nothing is picked or merged here.
 */
export async function claimLoginIdentity(
  tx: LoginClaimTx,
  args: { tenantId: string; email: string; exclude?: { userId?: string; memberId?: string } },
): Promise<LoginIdentityClaim> {
  const email = canonical(args.email);
  if (!args.tenantId || !email) throw new Error("claimLoginIdentity needs a tenant and an address");
  await lockLoginKeys(tx, [lockKey(args.tenantId, email)]);
  const found = (await findLoginHolders(tx, args.tenantId, [email])).get(email) ?? [];
  const rest = found.filter(
    (h) =>
      !(h.kind === "user" && args.exclude?.userId && h.id === args.exclude.userId) &&
      !(h.kind === "member" && args.exclude?.memberId && h.id === args.exclude.memberId),
  );
  return toClaim(rest);
}

/**
 * The bulk form (imports): lock every distinct canonical address in one
 * deadlock-safe order, then report the holders of each. Synthesised no-login
 * addresses are random and never shared, so they are neither locked nor
 * looked up (they map to `none`).
 */
export async function claimLoginIdentities(
  tx: LoginClaimTx,
  tenantId: string,
  emails: string[],
): Promise<Map<string, LoginIdentityClaim>> {
  if (!tenantId) throw new Error("claimLoginIdentities needs a tenant");
  const all = [...new Set(emails.filter((e) => typeof e === "string" && e.trim() !== "").map(canonical))];
  const real = all.filter((e) => !isSynthesisedEmail(e));
  await lockLoginKeys(tx, real.map((e) => lockKey(tenantId, e)));
  const found = await findLoginHolders(tx, tenantId, real);
  const out = new Map<string, LoginIdentityClaim>();
  for (const e of all) out.set(e, toClaim(found.get(e) ?? []));
  return out;
}

/**
 * Is `email` free to become a login for user `userId` in `tenantId`?
 * Login is per tenant (auth.ts resolves the club first, then the address),
 * and a User row takes precedence over a Member row with the same address —
 * so an address held by ANY other user or ANY member of the same club would
 * shadow or be shadowed by this account. The caller answers a collision
 * without saying whose it is.
 *
 * A thin wrapper over `claimLoginIdentity` (9 Oct 2026): the 7-Oct callers
 * (staff edit, own login email, operator owner change) take the claim lock
 * through it. Call it inside the writer's transaction, before the write.
 */
export async function loginEmailTaken(
  tx: LoginClaimTx,
  args: { tenantId: string; userId: string; email: string },
): Promise<boolean> {
  const claim = await claimLoginIdentity(tx, {
    tenantId: args.tenantId,
    email: args.email,
    exclude: { userId: args.userId },
  });
  return claim.kind !== "none";
}

/** Email-bound credential kinds `retireEmailBoundTokens` can retire. */
export type EmailBoundTokenPurpose = "reset" | "login" | "first_time_signup" | "waiver_open";

/** Sign-in credentials: what a login-address change must retire. A waiver link is not one. */
export const SIGN_IN_TOKEN_PURPOSES: readonly EmailBoundTokenPurpose[] = ["reset", "login", "first_time_signup"];

/**
 * Retire outstanding email-bound tokens for these addresses IN THIS CLUB
 * (another club's identical address is untouched): by default password-reset
 * codes and login/activation links. Marked used (not deleted) so the rows
 * stay as evidence. A waiver link is not a sign-in credential (magic-link
 * verify refuses that purpose) and is retired only when `purposes` names it.
 */
export async function retireEmailBoundTokens(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; emails: string[]; purposes?: readonly EmailBoundTokenPurpose[] },
): Promise<{ resetCodes: number; signInLinks: number }> {
  if (!args.tenantId) throw new Error("retireEmailBoundTokens needs a tenant");
  const emails = [...new Set(args.emails.map((e) => e.trim().toLowerCase()))];
  const purposes = new Set(args.purposes ?? SIGN_IN_TOKEN_PURPOSES);
  const linkPurposes = (["login", "first_time_signup", "waiver_open"] as const).filter((p) => purposes.has(p));
  const now = new Date();
  const resets = purposes.has("reset")
    ? await tx.passwordResetToken.updateMany({
        where: { tenantId: args.tenantId, email: { in: emails }, used: false },
        data: { used: true },
      })
    : { count: 0 };
  const links = linkPurposes.length > 0
    ? await tx.magicLinkToken.updateMany({
        where: {
          tenantId: args.tenantId,
          email: { in: emails },
          used: false,
          purpose: { in: [...linkPurposes] },
        },
        data: { used: true, usedAt: now },
      })
    : { count: 0 };
  return { resetCodes: resets.count, signInLinks: links.count };
}

/**
 * Check a staff user's authenticator code WITHOUT spending it (8 Oct 2026,
 * account-editing review D1): same rules as `consumeUserTotp` (six digits,
 * valid now, from a time-step later than the last one accepted). A route uses
 * it to refuse a wrong code BEFORE answering anything that depends on other
 * secrets, then spends the code with `consumeUserTotp` inside its transaction
 * — the spend is still the single-use guarantee.
 */
export function verifyUserTotpCode(
  user: { totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({
    token: code,
    secret: user.totpSecret,
    ...(user.totpLastUsedStep !== null ? { afterTimeStep: user.totpLastUsedStep } : {}),
  });
  return result.valid === true;
}

/**
 * Verify a staff user's authenticator code and SPEND it (single use across
 * instances), as `consumeOperatorTotp` does for operators: the code must be
 * valid and from a time-step later than the last one accepted for this user,
 * and the step is recorded with a conditional update so two requests racing
 * the same code cannot both win.
 */
export async function consumeUserTotp(
  tx: Prisma.TransactionClient,
  user: { id: string; totpSecret: string; totpLastUsedStep: number | null },
  code: string,
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({
    token: code,
    secret: user.totpSecret,
    ...(user.totpLastUsedStep !== null ? { afterTimeStep: user.totpLastUsedStep } : {}),
  });
  if (!result.valid) return false;
  const step = (result as { timeStep?: number }).timeStep;
  if (typeof step !== "number" || !Number.isSafeInteger(step)) return false;
  const spent = await tx.user.updateMany({
    where: {
      id: user.id,
      OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }],
    },
    data: { totpLastUsedStep: step },
  });
  return spent.count === 1;
}
