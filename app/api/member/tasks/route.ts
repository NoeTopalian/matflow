/**
 * GET /api/member/tasks
 *
 * Returns the logged-in member's open action list, blending two streams:
 *   - `member_note` Tasks from the DB (sent by staff via POST /api/tasks
 *     kind=member_note — see feat/member-tickable-notes Phase 5)
 *   - `system` actions derived from the member's own profile state
 *     (lib/member-actions.ts)
 *
 * Member-only. The companion endpoint `POST /api/member/tasks/[id]/complete`
 * lets the member tick a DB-stored task; system actions are stateless — they
 * vanish when the underlying condition resolves.
 *
 * Cache: private, no-store. State changes within seconds of any tick or
 * profile edit, and the list is per-user — caching has no upside here.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { getMemberSystemActions } from "@/lib/member-actions";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const memberId = (session.user as { memberId?: string }).memberId;
  if (!memberId) {
    // Staff-only sessions reach here when the staff member also has a
    // personal Member row for training (common in BJJ — owner trains too).
    // Without a memberId there's nothing to render — return an empty list
    // rather than 403 so the panel can show "no actions" without surfacing
    // an error to a perfectly normal staff session.
    return NextResponse.json(
      { items: [] },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }

  const tenantId = session.user.tenantId;

  const { systemActions, memberNotes } = await withTenantContext(tenantId, async (tx) => {
    const [sys, notes] = await Promise.all([
      getMemberSystemActions(tx, { memberId, tenantId }),
      tx.task.findMany({
        where: {
          tenantId,
          assigneeMemberId: memberId,
          kind: "member_note",
          status: "open",
        },
        select: {
          id: true,
          title: true,
          body: true,
          createdAt: true,
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);
    return { systemActions: sys, memberNotes: notes };
  });

  // Combined ordering: member_notes (newest first) then system actions
  // (by weight). Felt right in design review — staff-authored items get
  // top billing so they don't drown under static system suggestions.
  const items = [
    ...memberNotes.map((t) => ({
      id: t.id,
      kind: "member_note" as const,
      title: t.title,
      body: t.body,
      createdAt: t.createdAt.toISOString(),
      createdBy: t.createdBy,
      href: null as string | null,
    })),
    ...systemActions.map((s) => ({
      id: s.id,
      kind: "system" as const,
      title: s.title,
      body: s.body,
      createdAt: null,
      createdBy: null,
      href: s.href,
    })),
  ];

  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
