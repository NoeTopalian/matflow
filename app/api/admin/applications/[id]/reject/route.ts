/**
 * POST /api/admin/applications/[id]/reject
 * Body: { reason?: string }
 * Flips application status to "rejected" + records the reason in the audit log.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({ reason: z.string().max(500).optional() }).optional();

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const operator = await getOperatorContext(req);
  if (!operator.authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(`admin:application-action:${operator.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id } = await ctx.params;

  const raw = await req.text();
  let reason: string | undefined;
  if (raw.trim().length > 0) {
    try {
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) reason = parsed.data?.reason;
    } catch { /* ignore — reason is optional */ }
  }

  const application = await withRlsBypass((tx) =>
    tx.gymApplication.findUnique({ where: { id } }),
  );
  if (!application) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  await withRlsBypass((tx) =>
    tx.gymApplication.update({
      where: { id },
      data: { status: "rejected" },
    }),
  );

  // Audit iter-1-operator-admin A6I1-V-4: durable AuditLog entry for
  // rejection (was console.warn only — rotated out of Vercel logs after
  // retention; no queryable record of operator decision). tenantId is
  // null because no tenant exists for a rejected application; the
  // schema migration in this batch made AuditLog.tenantId nullable.
  // Still console.warn-shadow for prod log-trail.
  console.warn(
    `[admin/applications/${id}/reject] rejected ${application.gymName} ` +
      `operator=${operator.operatorEmail ?? operator.operatorId}${reason ? ` reason="${reason}"` : ""}`,
  );
  await logAudit({
    tenantId: null,
    userId: null,
    action: "admin.application.reject",
    entityType: "GymApplication",
    entityId: id,
    metadata: {
      gymName: application.gymName,
      reason: reason ?? null,
      operatorEmail: operator.operatorEmail ?? null,
    },
    actAsUserId: operator.operatorId,
    req,
  });

  return NextResponse.json({ ok: true });
}
