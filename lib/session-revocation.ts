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
 * **Why `unknown` is a distinct verdict.** It is reported differently (a
 * database that cannot answer is an incident; a moved version is routine), but
 * since 9 Oct 2026 (security campaign lane A, AH-G7 / SEC-012) the caller
 * REFUSES it exactly like `revoked`. Until then auth.ts kept the token on
 * `unknown`, so for as long as this lookup kept failing every revocation in
 * the product (password reset, log out everywhere, staff removal, suspension)
 * failed OPEN, on any request whose later queries happened to succeed (pool
 * exhaustion, a statement timeout, a policy rejection after the RLS cutover).
 * The old code before that was `catch { /* DB transient — keep token *\/ }`:
 * a silent, total, indefinite bypass, reported to nobody. The AH-G7 refusal
 * (jwt() → null) then signed people OUT on a blip, because proxy.ts runs under
 * the next-auth wrapper, which copies the cookie-clearing Set-Cookie onto the
 * reply (review R-1). Since SF-44 (lane A2, 9 Oct 2026) auth.ts refuses
 * `unknown` WITHOUT clearing the cookie: the token is kept, marked for
 * revalidation, carries no authority, and proxy.ts answers a retryable 503;
 * only `revoked` clears the cookie. See REVALIDATE_CLAIM in auth.ts.
 *
 * **Malformed results are `unknown`, not `ok`.** A row whose `sessionVersion`
 * is not an integer cannot prove anything, so it cannot admit anything. A
 * TOKEN whose version is not an integer is `revoked`: every minter in the
 * product writes one (auth.ts `?? 0`, magic-link verify, the re-encoders that
 * spread an existing token), so a token without one was not minted by us.
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
  /** We could not find out. The caller REFUSES this request — retryable, cookie kept, revalidated next time (SF-44) — and this is REPORTED. */
  | "unknown";

export interface SessionVersionCheck {
  /** Set for a member session; `auth.ts` keys on it to choose the table. */
  memberId?: string | null;
  /** The staff `User.id`. Used when there is no `memberId`. */
  userId?: string | null;
  /** The `sessionVersion` the token was minted with. */
  tokenVersion: unknown;
  /**
   * The token's club. When given, a row in another club is `revoked`: a
   * session is for one subject in one club, and an id that resolves elsewhere
   * is not that session (SEC-010 confusion guard; ids are cuids, so this is
   * defence in depth, not a reachable path today).
   */
  tenantId?: string | null;
}

function isVersion(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

export async function checkSessionVersion(
  check: SessionVersionCheck,
  /**
   * Called with the row's current display name when the version matches (8 Oct
   * 2026, account editing). The row is read anyway, so the token's name can
   * follow a profile edit on every device without a second query — and a
   * request in flight during the edit cannot leave a stale name behind.
   */
  onCurrentName?: (name: string) => void,
): Promise<RevocationVerdict> {
  const { memberId, userId, tokenVersion, tenantId } = check;
  if (!memberId && !userId) return "unknown";
  // Not minted by us (see the header): nothing to compare, nothing to admit.
  if (!isVersion(tokenVersion)) return "revoked";

  try {
    const row: unknown = await withRlsBypass((tx) =>
      memberId
        ? tx.member.findUnique({ where: { id: memberId }, select: { sessionVersion: true, name: true, tenantId: true } })
        : tx.user.findUnique({ where: { id: userId as string }, select: { sessionVersion: true, name: true, tenantId: true } }),
    );

    // THE FIX. `row === null` used to be indistinguishable from a match.
    if (row === null) return "revoked";
    // A result we cannot read proves nothing (SEC-012: malformed results).
    if (typeof row !== "object") return unknownVerdict(memberId, new Error("malformed revocation row"));
    const r = row as { sessionVersion?: unknown; name?: unknown; tenantId?: unknown };
    if (!isVersion(r.sessionVersion)) return unknownVerdict(memberId, new Error("malformed revocation row"));
    if (r.sessionVersion !== tokenVersion) return "revoked";
    if (tenantId && typeof r.tenantId === "string" && r.tenantId !== tenantId) return "revoked";
    if (onCurrentName && typeof r.name === "string") onCurrentName(r.name);
    return "ok";
  } catch (err) {
    return unknownVerdict(memberId, err);
  }
}

/**
 * Loud, not silent — and no longer permissive: auth.ts refuses the request
 * on this verdict. After the RLS role cutover a policy rejection would land
 * here too, the one failure mode that must never be mistaken for a blip.
 */
function unknownVerdict(memberId: string | null | undefined, err: unknown): RevocationVerdict {
  const code = (err as { code?: unknown } | null)?.code;
  console.error("[auth] session-revocation check failed — request REFUSED as unavailable (fail closed; session kept for revalidation)", {
    subject: memberId ? "member" : "user",
    // The driver/server code (57014 timeout, 57P01 connection loss, 42501
    // permission, P1001 unreachable…) so an incident can be told from a
    // policy rejection after the RLS cutover without reading the message.
    code: typeof code === "string" ? code : undefined,
    error: err instanceof Error ? err.message : String(err),
  });
  Sentry.captureException(err, {
    tags: { area: "auth", control: "session-revocation", failMode: "closed" },
  });
  return "unknown";
}
