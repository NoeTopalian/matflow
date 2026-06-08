import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { sendPushToMember } from "@/lib/push";
import { notesField } from "@/lib/schemas/notes-sanitiser";
import { assertSameOrigin } from "@/lib/csrf";
import { del } from "@vercel/blob";

// Lane 1 iter-2 L1-I2-S-06 [High] fix: restrict photoUrl to safe origins.
// Previous `z.string().min(1).max(3_500_000)` accepted ANY string including
// `javascript:alert(...)` — stored XSS in any future <a href={url}> render.
// SVG data URLs also rejected (SVG can carry inline script).
const PHOTO_URL_SCHEMA = z
  .string()
  .min(1)
  .max(3_500_000)
  .refine(
    (s) =>
      s.startsWith("data:image/png;base64,") ||
      s.startsWith("data:image/jpeg;base64,") ||
      s.startsWith("data:image/webp;base64,") ||
      /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(s),
    {
      message:
        "photoUrl must be a Vercel Blob URL or data:image/(png|jpeg|webp);base64,…",
    },
  );

const assignSchema = z.object({
  rankSystemId: z.string().min(1),
  stripes: z.number().int().min(0).max(10).default(0),
  // feat/member-tickable-notes Phase 1b: shared sanitiser — see lib/schemas/notes-sanitiser.ts
  notes: notesField(500),
  photoUrl: PHOTO_URL_SCHEMA.optional(),
  photoCaption: z.string().max(500).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canPromote = ["owner", "manager", "coach"].includes(session.user.role);
  if (!canPromote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { rankSystemId, stripes, notes } = parsed.data;

  try {
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      // Audit iter-4-database A8I4-V-3 [High]: existence check only —
      // result is narrowed to { id } and `.id` itself is not used. Select
      // minimum to keep credential material out of the process heap.
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: { id: true },
      });
      if (!member) return { kind: "no-member" as const };

      const rankSystem = await tx.rankSystem.findFirst({
        where: { id: rankSystemId, tenantId: session.user.tenantId },
      });
      if (!rankSystem) return { kind: "no-rank" as const };

      const existingRank = await tx.memberRank.findFirst({
        where: {
          memberId,
          rankSystem: { discipline: rankSystem.discipline, tenantId: session.user.tenantId },
        },
        include: { rankSystem: true },
      });

      if (existingRank) {
        const updated = await tx.memberRank.update({
          where: { id: existingRank.id },
          data: {
            rankSystemId,
            stripes,
            achievedAt: new Date(),
            promotedById: session.user.id,
            rankHistory: {
              create: {
                fromRankId: existingRank.rankSystemId,
                toRankId: rankSystemId,
                promotedById: session.user.id,
                notes,
              },
            },
          },
          include: { rankSystem: true },
        });
        return { kind: "updated" as const, value: updated, fromRankId: existingRank.rankSystemId };
      }

      // Task 7: upsert (not create) so concurrent first-promotion calls by two
      // staff don't race on the (memberId, rankSystemId) unique constraint.
      // RankHistory still gets a row per call, so the audit trail shows the conflict.
      const created = await tx.memberRank.upsert({
        where: { memberId_rankSystemId: { memberId, rankSystemId } },
        create: {
          memberId,
          rankSystemId,
          stripes,
          promotedById: session.user.id,
          rankHistory: {
            create: {
              fromRankId: null,
              toRankId: rankSystemId,
              promotedById: session.user.id,
              notes,
            },
          },
        },
        update: {
          stripes,
          achievedAt: new Date(),
          promotedById: session.user.id,
          rankHistory: {
            create: {
              fromRankId: null,
              toRankId: rankSystemId,
              promotedById: session.user.id,
              notes: notes ?? "concurrent-create-merged-via-upsert",
            },
          },
        },
        include: { rankSystem: true },
      });
      return { kind: "created" as const, value: created };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (result.kind === "no-rank") return NextResponse.json({ error: "Rank not found" }, { status: 404 });

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.rank.promote",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        fromRankId: result.kind === "updated" ? result.fromRankId : null,
        toRankId: rankSystemId,
        stripes,
      },
      req,
    });

    if (parsed.data.photoUrl && result.kind === "updated") {
      await withTenantContext(session.user.tenantId, async (tx) => {
        const oldPhotos = await tx.memberPhoto.findMany({
          where: { memberRankId: result.value.id, kind: "promotion" },
          select: { id: true, url: true },
        });
        if (oldPhotos.length > 0) {
          const blobUrls = oldPhotos
            .map((p) => p.url)
            .filter((u) => /public\.blob\.vercel-storage\.com/.test(u));
          if (blobUrls.length > 0) {
            try {
              await del(blobUrls);
            } catch (e) {
              console.warn("[rank/route] orphan blob delete failed (best-effort):", e);
            }
          }
          await tx.memberPhoto.deleteMany({
            where: { id: { in: oldPhotos.map((p) => p.id) } },
          });
        }
      });
    }

    if (parsed.data.photoUrl) {
      await withTenantContext(session.user.tenantId, (tx) =>
        tx.memberPhoto.create({
          data: {
            tenantId: session.user.tenantId,
            memberId,
            url: parsed.data.photoUrl!,
            caption: parsed.data.photoCaption ?? null,
            kind: "promotion",
            memberRankId: result.value.id,
            uploadedByMemberId: null,
          },
        }),
      );

      await logAudit({
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: "rank.photo_attached",
        entityType: "Member",
        entityId: memberId,
        metadata: {
          memberRankId: result.value.id,
          caption: parsed.data.photoCaption ?? null,
        },
        req,
      });
    }

    void sendPushToMember(memberId, {
      title: "Belt promotion!",
      body: `You've been awarded ${result.value.rankSystem.name}${result.value.stripes ? ` · ${result.value.stripes} stripe${result.value.stripes !== 1 ? "s" : ""}` : ""}.`,
      url: "/member/profile",
    });

    return NextResponse.json(result.value, { status: result.kind === "updated" ? 200 : 201 });
  } catch {
    return NextResponse.json({ error: "Failed to assign rank" }, { status: 500 });
  }
}
