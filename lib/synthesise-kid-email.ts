// Synthesised, unique-per-tenant email placeholders for Members who have no
// real address of their own.
//
// Two kinds of member need one. Kids never log in — they have
// `passwordHash: null` and are managed by their parent. Adults who simply do
// not have an email address (Noe, 19 Sep 2026: a real club has walk-ins, older
// members and families sharing one inbox) are the second: they train, they pay
// at the desk, and they must be on the roster. `Member.email` is NOT NULL and
// carries a `@@unique([tenantId, email])`, so a create needs *some* value.
//
// A synthesised address:
//   - Never collides — 16-byte hex = 2^128 entropy
//   - Cannot land in a real inbox — `.local` is RFC-2606 reserved
//   - Is self-documenting — `no-login.matflow.local` makes the intent obvious
//     in audit logs, CSV exports and DB dumps
//   - Is RECOGNISABLE, via `isSynthesisedEmail` below, so no send path can
//     mistake it for somewhere a person will read
//
// Used by the staff create-member flow (POST /api/members), the parent
// self-serve flow (POST /api/member/children), and by every send path that has
// to exclude these addresses. Keep this the single source — don't reintroduce a
// second format.
export const NO_LOGIN_EMAIL_DOMAIN = "no-login.matflow.local";

/**
 * A placeholder address for a member who has none. `kind` is a label only.
 *
 * Web Crypto rather than node's `randomBytes`, so this module carries no node
 * builtin and the recogniser below can be imported by the dashboard's client
 * components — the screens that must say "No email" instead of rendering a
 * placeholder as though it were real. Same 16 bytes, same entropy.
 */
export function synthesiseMemberEmail(kind: "kid" | "adult" = "adult"): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${kind}-${id}@${NO_LOGIN_EMAIL_DOMAIN}`;
}

/** The kids' flavour. Unchanged format — existing rows keep matching. */
export function synthesiseKidEmail(): string {
  return synthesiseMemberEmail("kid");
}

/**
 * True when this address is one MatFlow invented, and therefore nowhere a
 * person will ever read.
 *
 * Every send path must consult this before it mints a token or queues a
 * message: an invite to `kid-…@no-login.matflow.local` is a token nobody can
 * receive, an EmailLog row that will never be delivered, and — worst — a club
 * that believes it has invited a member it has not.
 *
 * Matched on the DOMAIN, not the prefix, so the kid/adult labels can change
 * without a send path silently starting to mail them. Case-insensitive: the
 * product does not canonicalise case anywhere else either.
 */
export function isSynthesisedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith(`@${NO_LOGIN_EMAIL_DOMAIN}`);
}

/**
 * The Prisma `where` fragment that excludes synthesised addresses from a
 * candidate set. Kept beside the predicate so the SQL-side and the JS-side
 * rules cannot drift apart.
 */
export const NOT_SYNTHESISED_EMAIL = {
  email: { not: { endsWith: `@${NO_LOGIN_EMAIL_DOMAIN}` } },
} as const;

/** The sentence the UI owes a member who has no address. British English. */
export const NO_EMAIL_EXPLANATION =
  "No email address — this member can't be sent an invite, a waiver link or a payment reminder. " +
  "Add an address to turn those back on.";
