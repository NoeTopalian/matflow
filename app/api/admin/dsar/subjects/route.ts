/**
 * GET /api/admin/dsar/subjects?q=<name or email>   (or ?id=<memberId>)
 *
 * The member picker for Settings → Data requests (PR 3, 6 Nov 2026). Owner
 * only, like the export and erase routes it feeds (requireApiOwner): a
 * manager or coach gets 403. Unlike every other member search it INCLUDES
 * archived members, because a formal erasure request can come from someone
 * the club has already removed, and erasing an archived member must work.
 * Returns at most 20 rows, never more than the picker shows.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { refuseSupportSession } from "@/lib/support-session";
import { apiError } from "@/lib/api-error";
import { ERASED_EMAIL } from "@/lib/login-email";

export const runtime = "nodejs";

const querySchema = z.union([
  z.object({ id: z.string().min(1).max(64), q: z.undefined() }),
  z.object({ q: z.string().trim().min(2).max(100), id: z.undefined() }),
]);

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const support = refuseSupportSession(gate.session); if (support) return support;
  const { tenantId } = gate;

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    id: url.searchParams.get("id") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) return NextResponse.json({ error: "Type at least 2 characters of a name or email." }, { status: 400 });

  try {
    const rows = await withTenantContext(tenantId, (tx) =>
      tx.member.findMany({
        where: {
          tenantId,
          ...(parsed.data.id
            ? { id: parsed.data.id }
            : {
                OR: [
                  { name: { contains: parsed.data.q, mode: "insensitive" } },
                  { email: { contains: parsed.data.q, mode: "insensitive" } },
                ],
              }),
        },
        select: { id: true, name: true, email: true, status: true, accountType: true, archivedAt: true, joinedAt: true },
        orderBy: [{ name: "asc" }],
        take: 20,
      }),
    );
    return NextResponse.json(
      rows.map((m) => ({
        id: m.id,
        name: m.name,
        email: m.email,
        status: m.status,
        accountType: m.accountType,
        archivedAt: m.archivedAt ? m.archivedAt.toISOString() : null,
        joinedAt: m.joinedAt.toISOString(),
        erased: ERASED_EMAIL.test(m.email),
      })),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (e) {
    return apiError("Couldn't search members", 500, e, "[api/admin/dsar/subjects GET]");
  }
}
