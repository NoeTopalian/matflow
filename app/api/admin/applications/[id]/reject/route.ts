/**
 * POST /api/admin/applications/[id]/reject
 * Body: { reason?: string }
 * Flips application status to "rejected" + records the reason in the audit log.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminAuthed } from "@/lib/admin-auth";

const schema = z.object({ reason: z.string().max(500).optional() }).optional();

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdminAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Super-admin scope — no tenant context exists for an unapproved application,
  // so log to console (Vercel logs / Sentry) rather than the tenant AuditLog table.
  console.warn(`[admin/applications/${id}/reject] rejected ${application.gymName}${reason ? ` reason="${reason}"` : ""}`);

  return NextResponse.json({ ok: true });
}
