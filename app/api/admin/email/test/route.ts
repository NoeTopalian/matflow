/**
 * POST /api/admin/email/test — send a test email AS THE SIGNED-IN CLUB.
 *
 * ⚠ THIS IS NOT AN OPERATOR ROUTE, despite its path.
 *
 * Round 1, defect 5. It sits under `/api/admin/**` — the super-admin prefix,
 * which `proxy.ts` lists in PUBLIC_PREFIXES precisely because every route
 * under it enforces MATFLOW_ADMIN_SECRET for itself. This one does not: it is
 * gated by `requireApiOwner()`, the TENANT owner gate. Two consequences a
 * reader has to know:
 *
 *   1. A MatFlow operator holding the platform master credential is REFUSED
 *      here. The send goes out as a club, from that club's tenant context and
 *      against that club's `email:test:<userId>` rate-limit bucket, so there
 *      is no sensible tenant to attribute an operator's call to. An operator
 *      who needs to test a club's email uses Impersonate first.
 *   2. Because the prefix is public at the edge, `requireApiOwner()` is the
 *      ONLY gate on this route. A future route added beside it and gated "the
 *      operator way" would be reachable by a tenant owner, and vice versa.
 *      Check which gate you want before copying a neighbour.
 *
 * It is documented rather than moved: the path is baked into the owner-facing
 * settings screen that calls it, and moving it is a UI change this lane does
 * not own. Recorded in the J60 manifest note in
 * `tests/e2e/campaign/assess/journeys.ts` and asserted in `lg-1-operator-plane.spec.ts`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner } from "@/lib/api-authz";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({
  to: z.string().email(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  const rl = await checkRateLimit(`email:test:${userId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many test emails. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const result = await sendEmail({
    tenantId,
    templateId: "test",
    to: parsed.data.to,
    vars: { message: parsed.data.message ?? "If you can read this, transactional email is working." },
  });

  if (result.ok) {
    await logAudit({
      tenantId,
      userId,
      action: "email.test_sent",
      entityType: "Tenant",
      entityId: tenantId,
      metadata: {
        to: parsed.data.to,
        messageLength: parsed.data.message?.length ?? 0,
      },
      req,
    });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
