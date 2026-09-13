import * as Sentry from "@sentry/nextjs";
import { withRlsBypass } from "@/lib/prisma-tenant";

/**
 * Is this session still allowed to exist?
 *
 * Extracted from the JWT callback in `auth.ts`, and the extraction is the point:
 * the check lived inline inside a NextAuth config object, so nothing in the test
 * suite could reach it. That is why the defect below survived — the control that
 * revokes access had no test, in a codebase with 1300 of them.
 *
 * **The defect.** The callback read:
 *
 *     const currentVersion = tokenMemberId
 *       ? (await prisma.member.findUnique({ ... }))?.sessionVersion
 *       : (await prisma.user.findUnique({ ... }))?.sessionVersion;
 *     if (currentVersion !== undefined && currentVersion !== token.sessionVersion) {
 *       return null;
 *     }
 *
 * `?.` collapses two completely different facts into one `undefined`: "the row
 * is gone" and "there is nothing to compare". Hard-deleting a staff member
 * (`app/api/staff/[id]/route.ts`) cannot bump a `sessionVersion` on a row that
 * no longer exists, so the lookup returned nothing, the guard was skipped, and
 * the removed coach kept a working dashboard for the rest of the JWT's 30 days —
 * while `SettingsPage.tsx` told the owner the removal took effect immediately.
 * Identical for hard-deleted members.
 *
 * **A missing row is a revoked session.** There is no reading under which a
 * token pointing at a row that does not exist should be honoured.
 *
 * **Why `unknown` is a distinct verdict.** A database blip must not sign out
 * every user in the product, so the caller keeps the token — but that is a
 * deliberate fail-open on a security control and it has to be *visible*. The
 * old code was `catch { /* DB transient — keep token *\/ }`: a silent, total,
 * indefinite bypass of every revocation in the product, reported to nobody.
 *
 * **RLS.** The lookups go through `withRlsBypass` rather than the bare client.
 * Production currently connects as a BYPASSRLS role, so the bare client worked
 * — and would keep appearing to work right up until the planned cutover to the
 * restricted role, at which point these queries would silently return zero rows
 * and every revocation in the product would fail open at once: password reset,
 * "log out everywhere", suspension, staff removal. Only revocation would even
 * look like a security failure. Wrapping them now means the cutover cannot do
 * that.
 */
export type RevocationVerdict =
  /** The row exists and its version matches — carry on. */
  | "ok"
  /** The row is gone, or its version moved. Kill the session. */
  | "revoked"
  /** We could not find out. The caller keeps the token and this is REPORTED. */
  | "unknown";

export interface SessionVersionCheck {
  /** Set for a member session; `auth.ts` keys on it to choose the table. */
  memberId?: string | null;
  /** The staff `User.id`. Used when there is no `memberId`. */
  userId?: string | null;
  /** The `sessionVersion` the token was minted with. */
  tokenVersion: unknown;
}

export async function checkSessionVersion(
  check: SessionVersionCheck,
): Promise<RevocationVerdict> {
  const { memberId, userId, tokenVersion } = check;
  if (!memberId && !userId) return "unknown";

  try {
    const row = await withRlsBypass((tx) =>
      memberId
        ? tx.member.findUnique({ where: { id: memberId }, select: { sessionVersion: true } })
        : tx.user.findUnique({ where: { id: userId as string }, select: { sessionVersion: true } }),
    );

    // THE FIX. `row === null` used to be indistinguishable from a match.
    if (row === null) return "revoked";
    return row.sessionVersion === tokenVersion ? "ok" : "revoked";
  } catch (err) {
    // Loud, not silent. Every revocation in the product is failing open for as
    // long as this keeps happening, and after the RLS role cutover a policy
    // rejection would land here too — the one failure mode that must never be
    // mistaken for a transient blip.
    console.error("[auth] session-revocation check failed — token KEPT, revocation is failing open", {
      subject: memberId ? "member" : "user",
      error: err instanceof Error ? err.message : String(err),
    });
    Sentry.captureException(err, {
      tags: { area: "auth", control: "session-revocation", failMode: "open" },
    });
    return "unknown";
  }
}
