/**
 * Subject binding for email-bound sign-in tokens (security campaign lane A,
 * 9 Oct 2026; admin hub ledger AH-D2, catalogue SEC-003 / SEC-004).
 *
 * THE GAP. MagicLinkToken and PasswordResetToken rows name a club and an
 * ADDRESS, never a person: every consumer (magic-link verify, accept-invite,
 * reset-password) finds its subject by (tenantId, token.email) at the moment
 * of use. So a token minted for person A authenticates whoever holds that
 * address in that club when it is redeemed. The address writers that MOVE an
 * address retire the tokens (lib/login-email.ts retireEmailBoundTokens), but
 * the writers that DELETE a holder and CREATE a new one do not: deleting a
 * member (lib/member-delete.ts), removing a staff user (app/api/staff/[id]
 * DELETE) and rolling back an import leave the old holder's links alive, and
 * the next record created at that address inherits them — for up to 7 days
 * for an invitation (tests/integration/sec-a-token-subject-binding-db.test.ts
 * reproduces it on Postgres).
 *
 * THE BINDING, WITHOUT A MIGRATION. The schema is not this lane's to change,
 * and a column could be rewritten by the very writers that caused the gap. So
 * the binding lives in the credential itself:
 *
 *   - LINKS (login, first_time_signup, waiver_open): the raw token handed out
 *     is `<random>.<tag>`, where tag = HMAC(secret, purpose, tenant, subject
 *     kind and id, random), 128 bits. The row is still found by
 *     hashToken(raw), so storage and lookup are unchanged. The consumer
 *     resolves its subject exactly as before and then recomputes the tag for
 *     THAT subject: a different person (a different id, even at the same
 *     address, even the same kind) does not match and the token is refused.
 *   - RESET CODES (six digits typed by a person, so nothing can ride along):
 *     the stored hash itself commits to the subject — HMAC over the purpose,
 *     tenant, subject kind and id, and the code. The consumer resolves its
 *     subject and looks for the hash computed for that subject.
 *
 * Immutable by construction: no database write can re-point a token at a new
 * subject, because the subject is inside an HMAC the database never sees the
 * key of. The address binding stays as well (the row is still looked up in
 * the club, and the subject is still resolved by the address), so a token
 * dies both when its address moves (retirement) and when its person changes.
 *
 * LEGACY. A link minted before this module (no `.tag`) has no binding; the
 * consumers accept it on the old address-only rule, which is no worse than
 * before, and it ages out with its expiry (30 minutes for a login link, 7 days
 * for an invitation). Issuers outside lane A's file scope still mint untagged
 * invitations until they call mintSubjectBoundToken — listed in
 * docs/security/evidence/A/REPORT.md with the exact one-line changes.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hashToken } from "@/lib/token-hash";

export type TokenSubjectKind = "user" | "member";
export type TokenSubject = { kind: TokenSubjectKind; id: string };
export type BoundLinkPurpose = "login" | "first_time_signup" | "waiver_open";

const LINK_DOMAIN = "auth-token-subject.link.v1";
const RESET_DOMAIN = "auth-token-subject.reset.v1";
const RANDOM_HEX_RE = /^[a-f0-9]{64}$/;
const TAG_HEX_RE = /^[a-f0-9]{32}$/;

function mac(parts: string[]): string {
  // The same keyed HMAC every stored token hash uses (lib/token-hash.ts), so
  // this module adds no second key path. Domain-separated by the first part
  // ("auth-token-subject.…"), which no raw token (hex) can begin with; parts
  // are newline-separated and none of them (cuids, purposes, hex) contains one.
  return hashToken(parts.join("\n"));
}

function linkTag(random: string, args: { purpose: BoundLinkPurpose; tenantId: string; subject: TokenSubject }): string {
  return mac([LINK_DOMAIN, args.purpose, args.tenantId, args.subject.kind, args.subject.id, random]).slice(0, 32);
}

/**
 * A fresh raw link token bound to ONE subject in ONE club for ONE purpose.
 * Store hashToken(raw) exactly as before; hand `raw` out.
 */
export function mintSubjectBoundToken(args: {
  purpose: BoundLinkPurpose;
  tenantId: string;
  subject: TokenSubject;
}): string {
  if (!args.tenantId || !args.subject?.id) throw new Error("a bound token needs a club and a subject");
  const random = randomBytes(32).toString("hex");
  return `${random}.${linkTag(random, args)}`;
}

export type BindingVerdict =
  /** Tagged, and the tag is this subject's. */
  | "bound"
  /** Tagged for someone else (or another club or purpose), or malformed. Refuse. */
  | "mismatch"
  /** No tag: minted before binding existed. The caller applies the old address-only rule. */
  | "legacy";

/** Does this raw link token belong to this subject? Constant-time on the tag. */
export function linkTokenBinding(
  raw: string,
  args: { purpose: BoundLinkPurpose; tenantId: string; subject: TokenSubject | null },
): BindingVerdict {
  if (typeof raw !== "string") return "mismatch";
  const dot = raw.indexOf(".");
  if (dot === -1) return "legacy";
  const random = raw.slice(0, dot);
  const tag = raw.slice(dot + 1);
  if (!RANDOM_HEX_RE.test(random) || !TAG_HEX_RE.test(tag)) return "mismatch";
  if (!args.subject?.id || !args.tenantId) return "mismatch";
  const expected = Buffer.from(linkTag(random, { ...args, subject: args.subject }), "hex");
  const actual = Buffer.from(tag, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? "bound" : "mismatch";
}

/**
 * The stored hash of a six-digit reset code, committed to the subject it was
 * sent for. A consumer that resolves a different subject computes a different
 * hash and finds nothing.
 */
export function hashSubjectBoundResetCode(code: string, args: { tenantId: string; subject: TokenSubject }): string {
  if (!args.tenantId || !args.subject?.id) throw new Error("a bound reset code needs a club and a subject");
  return mac([RESET_DOMAIN, args.tenantId, args.subject.kind, args.subject.id, code]);
}
