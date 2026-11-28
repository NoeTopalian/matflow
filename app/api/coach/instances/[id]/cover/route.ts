/**
 * POST /api/coach/instances/[id]/cover — one session-cover action on one dated session (Noe, 26 Nov 2026).
 *
 * Body: { action, coachUserId? }
 *   request    owner or manager; or the class's own linked coach (Class.coachUserId — a typed name never counts)
 *   claim      any eligible member of staff ("I'll cover this class"); the first valid claim wins
 *   assign     owner or manager, naming the coach directly (no open request needed)
 *   replace    owner or manager, a different coach for a covered session
 *   give_up    the covering coach (or the owner or a manager), before the session starts; reopens the request
 *   withdraw   owner or manager
 *   return     owner or manager: back to the class's regular coach
 *   reconfirm  the covering coach, after the session's time changed
 *
 * Staff only (requireApiStaff); what each role may do is decided in lib/session-cover.ts applyCoverAction, inside
 * one tenant transaction that also writes the Activity row. Nothing here changes the weekly class, a booking, the
 * attendance permissions or the session's time. No email, push or SMS is sent.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiStaff } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { apiError } from "@/lib/api-error";
import { applyCoverAction } from "@/lib/session-cover";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["request", "claim", "give_up", "withdraw", "return", "reconfirm"]) }),
  z.object({ action: z.enum(["assign", "replace"]), coachUserId: z.string().min(1).max(64) }),
]);

export async function POST(req: Request, { params }: Params) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId, role } = gate;
  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });

  try {
    const outcome = await withTenantContext(tenantId, (tx) => applyCoverAction(tx, { tenantId, userId, role }, id, parsed.data));
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, code: outcome.code, ...(outcome.conflict ? { conflict: outcome.conflict } : {}) },
        { status: outcome.status },
      );
    }
    return NextResponse.json({ changed: outcome.changed, cover: outcome.cover, session: outcome.session }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return apiError("Couldn't save the cover for this session", 500, e, "coach/instances/cover/POST", { req, tenantId, userId });
  }
}
