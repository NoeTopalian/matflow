// POST /api/members/bulk-invite
//
// Sends (or re-sends) first-time login invites to adult members who have an
// email but no password — the state every CSV-imported member lands in.
// Without this, an imported gym's entire member base is permanently locked
// out: the import commit mints no tokens, and both magic-link and
// forgot-password refuse null-password members by design.
//
// Body: { memberIds?: string[] } — omit to target every eligible member.
// Re-sending invalidates the member's previous unused invite tokens so only
// the newest link works (same hygiene as the waiver-link route).

import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { z } from "zod";
import { requireApiStaff } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { assertSameOrigin } from "@/lib/csrf";
import { getBaseUrl } from "@/lib/env-url";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";

export const runtime = "nodejs";
// Sequential email sends for a few hundred members can exceed the default
// function budget — mirror the import commit route.
export const maxDuration = 300;

const MAX_BATCH = 500;
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches members/route.ts

const bodySchema = z.object({
  memberIds: z.array(z.string().min(1)).max(MAX_BATCH).optional(),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  // Eligibility: adults (kids are passwordless by design), with an email,
  // who cannot currently log in (no passwordHash).
  const { candidates, tenant } = await withTenantContext(tenantId, async (tx) => {
    // Member.email is non-nullable (kids get synthesised addresses) — the
    // kids exclusion below is what keeps synthetic inboxes out of the send.
    const candidates = await tx.member.findMany({
      where: {
        tenantId,
        ...(parsed.data.memberIds ? { id: { in: parsed.data.memberIds } } : {}),
        accountType: { not: "kids" },
        passwordHash: null,
      },
      select: { id: true, name: true, email: true },
      take: MAX_BATCH,
    });
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return { candidates, tenant };
  });

  if (candidates.length === 0) {
    return NextResponse.json({ invited: 0, failed: [], message: "No members need an invite — everyone eligible already has login access or an email is missing." });
  }

  const base = getBaseUrl(req);
  const gymName = tenant?.name ?? "your gym";
  let invited = 0;
  const failed: { id: string; error: string }[] = [];

  for (const member of candidates) {
    const email = member.email!;
    try {
      const token = randomBytes(24).toString("hex");
      await withTenantContext(tenantId, async (tx) => {
        // Only the newest invite link should work.
        await tx.magicLinkToken.updateMany({
          where: { email, tenantId, purpose: "first_time_signup", used: false },
          data: { used: true, usedAt: new Date() },
        });
        await tx.magicLinkToken.create({
          data: {
            tenantId,
            email,
            tokenHash: hashToken(token),
            purpose: "first_time_signup",
            expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
          },
        });
      });
      const inviteUrl = `${base}/login/accept-invite?token=${encodeURIComponent(token)}`;
      const result = await sendEmail({
        tenantId,
        templateId: "invite_member",
        to: email,
        vars: { memberName: member.name, gymName, link: inviteUrl },
      });
      if (result && typeof result === "object" && "ok" in result && !result.ok) {
        failed.push({ id: member.id, error: "Email send failed" });
        continue;
      }
      invited++;
    } catch (e) {
      console.error("[members/bulk-invite] failed for member", member.id, e);
      failed.push({ id: member.id, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  await logAudit({
    tenantId,
    userId,
    action: "member.bulk_invite",
    entityType: "Tenant",
    entityId: tenantId,
    metadata: {
      requested: parsed.data.memberIds?.length ?? null,
      eligible: candidates.length,
      invited,
      failed: failed.length,
    },
    req,
  });

  return NextResponse.json({ invited, eligible: candidates.length, failed });
}
