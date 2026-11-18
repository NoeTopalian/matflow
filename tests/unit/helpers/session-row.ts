/**
 * The revocation check reads the person's row and the session's sign-out record in ONE statement since Round 8
 * (16 Nov 2026, lib/session-revocation.ts readSessionRow). Tests written against the older per-table `findUnique`
 * keep their mocks: this answers that statement from them, exactly as the old code read them — a null row is "no
 * row", anything else non-object is passed through as a malformed row — plus `sessionRevoked` from `isRevoked(sid)`.
 */
type FindUnique = (args: unknown) => unknown;

export function sessionRowRaw(
  models: { member: { findUnique: FindUnique }; user: { findUnique: FindUnique } },
  isRevoked: (sid: unknown) => unknown = () => false,
) {
  return async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const member = strings.join("?").includes('FROM "Member"');
    const [sid, id] = values;
    const row = await (member ? models.member : models.user).findUnique({
      where: { id },
      select: member
        ? { sessionVersion: true, name: true, tenantId: true, archivedAt: true }
        : { sessionVersion: true, name: true, tenantId: true, deactivatedAt: true },
    });
    if (row === null) return [];
    if (typeof row !== "object") return [row];
    return [{ ...(row as object), sessionRevoked: (await isRevoked(sid)) === true }];
  };
}
