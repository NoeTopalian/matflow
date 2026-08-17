/**
 * GET /api/member/me
 * Returns the logged-in member's profile, current belt, and attendance stats.
 * Falls back to demo data if not connected to DB.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { stripTotpFields } from "@/lib/totp-immutable";
import { computeMemberStats } from "@/lib/member-stats";
import { buildRankTimeline } from "@/lib/member-home";
import { memberSelfUpdateSchema } from "@/lib/schemas/member";

const DEMO_RESPONSE = {
  id: "demo-member",
  name: "Alex Johnson",
  email: "alex@example.com",
  phone: null,
  membershipType: "Monthly",
  status: "active",
  joinedAt: "2025-09-01T00:00:00.000Z",
  primaryColor: "#3b82f6",
  onboardingCompleted: false,
  classReminders: true,
  beltPromotions: true,
  gymAnnouncements: true,
  belt: {
    name: "Blue Belt",
    color: "#3b82f6",
    stripes: 3,
    achievedAt: "2026-02-01T00:00:00.000Z",
    promotedBy: "Coach Mike",
  },
  // Demo mode ships no fabricated lineage — the Progress page renders the
  // journey card from the belt + joinedAt alone when this is empty.
  rankTimeline: [],
  stats: {
    thisWeek: 3,
    thisMonth: 9,
    thisYear: 47,
    streakWeeks: 8,
    totalClasses: 47,
    attendanceByClass: [
      { id: "demo-c1", name: "Beginner BJJ", count: 18 },
      { id: "demo-c2", name: "No-Gi", count: 12 },
      { id: "demo-c3", name: "Open Mat", count: 9 },
    ],
    avgClassesPerWeek: 3.2,
  },
  nextClass: {
    id: "demo-inst-1",
    classId: "demo-c1",
    name: "Beginner BJJ",
    coach: "Coach Mike",
    location: "Mat 1",
    date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    startTime: "18:00",
    endTime: "19:00",
  },
};

export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Demo fallback
  if (session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ...DEMO_RESPONSE, name: session.user.name ?? DEMO_RESPONSE.name });
  }

  try {
    const memberId = session.user.memberId as string | undefined;
    if (!memberId) {
      // A real session without a member id is a data problem, not a demo:
      // fabricating "Alex Johnson" here showed a real user someone else's
      // identity with HTTP 200 (UI-RULES §7 violation, e2e honesty guard).
      return NextResponse.json({ error: "No member record for this session" }, { status: 404 });
    }

    // Audit iter-2 A5I2-P-2: collapse the GET path's 3 sequential
    // withTenantContext blocks (member.findFirst, computeMemberStats,
    // user.findUnique for promotedBy) into 1. Each withTenantContext
    // acquires + releases a pooled connection, so the previous shape
    // paid 3× the Neon connection-setup cost (~5–15ms each on a cold
    // pool) in the common case where currentRank.promotedById is set.
    // Now: 1 connection, 3 internal queries — they were already going
    // to be issued sequentially because they depend on each other, but
    // now they share the same transaction client.
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const m = await tx.member.findFirst({
        where: { id: memberId, tenantId: session.user.tenantId },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          membershipType: true,
          status: true,
          joinedAt: true,
          onboardingCompleted: true,
          // Drives parent-mode rendering on /member/home (Session E follow-up).
          accountType: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          medicalConditions: true,
          dateOfBirth: true,
          waiverAccepted: true,
          waiverAcceptedAt: true,
          classReminders: true,
          beltPromotions: true,
          gymAnnouncements: true,
          // 2FA-optional spec (2026-05-07): consumed by Recommend2FABanner on
          // /member/home. Banner shows when totpEnabled=false AND hasPassword=true.
          totpEnabled: true,
          passwordHash: true,
          memberRanks: {
            orderBy: { achievedAt: "desc" },
            take: 1,
            include: { rankSystem: true },
          },
          // feat/member-profile-pictures Track A Phase A2: pull the current
          // profile picture inline. Partial unique index guarantees at most
          // one matching row per member, so take:1 is exact.
          photos: {
            where: { kind: "profile" },
            select: { url: true },
            take: 1,
          },
        },
      });

      if (!m) return null;

      // US-4: stats + nextClass come from the shared helper so the kid endpoint
      // (`/api/member/children/[id]`) returns the same shape this route does.
      const { stats, nextClass } = await computeMemberStats(tx, {
        memberId,
        tenantId: session.user.tenantId,
      });

      const cr = m.memberRanks[0];

      // LB-007 (audit H4): resolve promoter's name when promotedById is set.
      // Previously promotedBy was hardcoded to null even though promotedById is
      // stored on every promotion (see /api/members/[id]/rank lines 66, 71, 95, 100).
      let promotedBy: { id: string; name: string } | null = null;
      if (cr?.promotedById) {
        const promoter = await tx.user.findUnique({
          where: { id: cr.promotedById },
          select: { id: true, name: true },
        });
        if (promoter) promotedBy = promoter;
      }

      // Progress-page lineage timeline ("Your Journey") — shared builder so
      // /api/member/home returns the identical shape.
      const rankTimeline = await buildRankTimeline(tx, { memberId });

      return { member: m, stats, nextClass, promotedBy, rankTimeline };
    });

    if (!result) return NextResponse.json({ error: "Member not found" }, { status: 404 });

    const { member, stats: computedStats, nextClass, promotedBy, rankTimeline } = result;
    const currentRank = member.memberRanks[0];

    // Audit iter-1-member-surface A5H-8: cache the response so the
    // layout-mounted Recommend2FABannerMember and the page's own
    // loadPageData() don't both pay the full DB cost on every nav. 30s
    // browser cache + 5m stale-while-revalidate is acceptable since the
    // payload only changes on explicit profile save (PATCH bypasses cache
    // automatically). Per-user, never shared (`private`).
    return NextResponse.json({
      id: member.id,
      name: member.name,
      email: member.email,
      phone: member.phone,
      membershipType: member.membershipType,
      status: member.status,
      joinedAt: member.joinedAt.toISOString(),
      primaryColor: session.user.primaryColor ?? "#3b82f6",
      onboardingCompleted: member.onboardingCompleted,
      accountType: member.accountType,
      emergencyContactName: member.emergencyContactName ?? null,
      emergencyContactPhone: member.emergencyContactPhone ?? null,
      emergencyContactRelation: member.emergencyContactRelation ?? null,
      medicalConditions: member.medicalConditions ?? null,
      dateOfBirth: member.dateOfBirth ? member.dateOfBirth.toISOString() : null,
      waiverAccepted: member.waiverAccepted,
      waiverAcceptedAt: member.waiverAcceptedAt ? member.waiverAcceptedAt.toISOString() : null,
      classReminders: member.classReminders,
      beltPromotions: member.beltPromotions,
      gymAnnouncements: member.gymAnnouncements,
      // 2FA-optional spec: drives Recommend2FABanner on /member/home.
      totpEnabled: member.totpEnabled,
      hasPassword: member.passwordHash !== null,
      belt: currentRank
        ? {
            name: currentRank.rankSystem.name,
            color: currentRank.rankSystem.color ?? "#e5e7eb",
            stripes: currentRank.stripes,
            achievedAt: currentRank.achievedAt.toISOString(),
            promotedBy,
          }
        : null,
      rankTimeline,
      stats: computedStats,
      nextClass,
      // feat/member-profile-pictures Track A: surface the current profile
      // picture URL or null so the member page can render it without a
      // second round-trip. Empty array → null.
      profilePictureUrl: member.photos[0]?.url ?? null,
    }, {
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=300" },
    });
  } catch (err) {
    // UI-RULES §7: a DB error must never impersonate data. This previously
    // returned DEMO_RESPONSE ("Alex Johnson") to REAL tenants on any error;
    // the member app shows its retry banner off the error status instead.
    // 503 (not 500): the failure is transient availability, and the unit
    // suite pins this status. DEMO_RESPONSE remains reachable only via the
    // demo-tenant branch above. (Both sides of the 2026-08-17 merge fixed
    // this independently — this is the union.)
    console.error("[member/me] GET failed", err);
    return NextResponse.json({ error: "Temporarily unavailable" }, { status: 503 });
  }
}

export async function PATCH(req: Request) {
  // Audit iter-1-member-lifecycle A3H-1: CSRF guard on member self-service
  // profile mutation. Imported inline to keep the existing top-of-file
  // import structure stable for the audit-only fix.
  const { assertSameOrigin } = await import("@/lib/csrf");
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberId = session.user.memberId as string | undefined;
  if (!memberId || session.user.tenantId === "demo-tenant") {
    return NextResponse.json({ ok: true }); // no-op for demo
  }

  try {
    // Defence in depth: strip TOTP fields so a body like { totpEnabled: false }
    // cannot bypass the no-self-disable invariant via this PATCH route.
    const rawBody = stripTotpFields(await req.json() as Record<string, unknown>);
    const body = rawBody as {
      onboardingCompleted?: boolean;
      name?: string;
      email?: string;
      phone?: string;
      belt?: string;
      stripes?: number;
      emergencyContactName?: string;
      emergencyContactPhone?: string;
      emergencyContactRelation?: string;
      medicalConditions?: string[];
      dateOfBirth?: string;
      waiverAccepted?: boolean;
      hasKidsHint?: boolean;
      // Session E follow-up: member self-marks as "parent" during the
      // shortened parent-only onboarding flow. Server clamps to a fixed
      // allowlist (mirrors the DB CHECK constraint).
      accountType?: string;
      // RB-005: notification preferences
      classReminders?: boolean;
      beltPromotions?: boolean;
      gymAnnouncements?: boolean;
    };
    const { onboardingCompleted, name, email, phone, belt, stripes,
            emergencyContactName, emergencyContactPhone, emergencyContactRelation,
            medicalConditions, dateOfBirth, waiverAccepted, hasKidsHint, accountType,
            classReminders, beltPromotions, gymAnnouncements } = body;

    // Profile-edit feature (2026-08-17): the identity trio is zod-validated —
    // name length, real email shape, UK/E.164 phone normalisation — instead of
    // the previous bare typeof checks. Only keys the client actually sent are
    // validated, so partial PATCHes (e.g. notification toggles) skip this.
    const identityInput: Record<string, unknown> = {};
    if (name !== undefined) identityInput.name = name;
    if (email !== undefined) identityInput.email = email;
    if (phone !== undefined) identityInput.phone = phone === "" ? null : phone;
    const parsedIdentity = memberSelfUpdateSchema.safeParse(identityInput);
    if (!parsedIdentity.success) {
      const flat = parsedIdentity.error.flatten().fieldErrors;
      return NextResponse.json(
        {
          error: "Validation failed",
          fieldErrors: {
            name: flat.name?.[0],
            email: flat.email?.[0],
            phone: flat.phone?.[0],
          },
        },
        { status: 400 },
      );
    }
    const identity = parsedIdentity.data;

    // Before-values for the owner-side version history (audit trail). One read
    // covers the email-change guards AND the from→to diff. Only fetched when
    // an identity/contact field is actually being changed.
    const touchesIdentity =
      identity.name !== undefined || identity.email !== undefined || identity.phone !== undefined ||
      typeof emergencyContactName === "string" || typeof emergencyContactPhone === "string" ||
      typeof emergencyContactRelation === "string" || (typeof dateOfBirth === "string" && dateOfBirth);
    const before = touchesIdentity
      ? await withTenantContext(session.user.tenantId, (tx) =>
          tx.member.findFirst({
            where: { id: memberId, tenantId: session.user.tenantId },
            select: {
              name: true, email: true, phone: true, accountType: true,
              emergencyContactName: true, emergencyContactPhone: true,
              emergencyContactRelation: true, dateOfBirth: true,
            },
          }),
        )
      : null;

    const updateData: Record<string, unknown> = {};
    if (typeof onboardingCompleted === "boolean") updateData.onboardingCompleted = onboardingCompleted;
    if (identity.name !== undefined) updateData.name = identity.name;
    if (identity.phone !== undefined) updateData.phone = identity.phone;

    if (identity.email !== undefined && before) {
      // Email is the login identifier — structural addresses can't be edited:
      // kid accounts carry synthesised no-inbox placeholders (editing one
      // re-opens the magic-link login surface), and GDPR-erased sentinels are
      // permanent tombstones.
      const currentEmail = before.email ?? "";
      const structural =
        before.accountType === "kids" ||
        currentEmail.endsWith("@no-login.matflow.local") ||
        currentEmail.endsWith("@deleted.invalid");
      if (structural) {
        return NextResponse.json(
          { error: "This account's email is managed by the gym and can't be changed here." },
          { status: 403 },
        );
      }
      if (identity.email !== currentEmail) updateData.email = identity.email;
    }
    if (typeof emergencyContactName === "string") updateData.emergencyContactName = emergencyContactName.trim().slice(0, 120) || null;
    if (typeof emergencyContactPhone === "string") updateData.emergencyContactPhone = emergencyContactPhone.trim().slice(0, 30) || null;
    if (typeof emergencyContactRelation === "string") updateData.emergencyContactRelation = emergencyContactRelation.trim().slice(0, 60) || null;
    if (Array.isArray(medicalConditions)) updateData.medicalConditions = JSON.stringify(medicalConditions);
    if (typeof dateOfBirth === "string" && dateOfBirth) {
      const d = new Date(dateOfBirth);
      if (!isNaN(d.getTime())) updateData.dateOfBirth = d;
    }
    if (typeof hasKidsHint === "boolean") updateData.hasKidsHint = hasKidsHint;
    // accountType: members can self-promote to "parent" or revert to "adult"
    // only. "kids" and "junior" are staff-managed (assigned via the link-child
    // / staff dashboard flow). Anything outside the allowlist is silently
    // dropped — defence-in-depth on top of the DB CHECK constraint.
    if (typeof accountType === "string" && (accountType === "parent" || accountType === "adult")) {
      updateData.accountType = accountType;
    }
    if (typeof classReminders === "boolean") updateData.classReminders = classReminders;
    if (typeof beltPromotions === "boolean") updateData.beltPromotions = beltPromotions;
    if (typeof gymAnnouncements === "boolean") updateData.gymAnnouncements = gymAnnouncements;

    // Server-side trio enforcement: setting onboardingCompleted=true requires
    // emergency contact name/phone/relation. Mirrors the waiver gate below so
    // a client that bypasses step-6 client validation can't slip through.
    if (onboardingCompleted === true) {
      const existingForOnboarding = await withTenantContext(session.user.tenantId, (tx) =>
        tx.member.findFirst({
          where: { id: memberId, tenantId: session.user.tenantId },
          select: {
            onboardingCompleted: true,
            emergencyContactName: true,
            emergencyContactPhone: true,
            emergencyContactRelation: true,
          },
        }),
      );
      if (!existingForOnboarding?.onboardingCompleted) {
        const trioName = typeof emergencyContactName === "string"
          ? emergencyContactName.trim()
          : existingForOnboarding?.emergencyContactName?.trim();
        const trioPhone = typeof emergencyContactPhone === "string"
          ? emergencyContactPhone.trim()
          : existingForOnboarding?.emergencyContactPhone?.trim();
        const trioRelation = typeof emergencyContactRelation === "string"
          ? emergencyContactRelation.trim()
          : existingForOnboarding?.emergencyContactRelation?.trim();
        if (!trioName || !trioPhone || !trioRelation) {
          return NextResponse.json(
            { error: "Emergency contact name, phone, and relation are required to complete onboarding." },
            { status: 400 },
          );
        }
      }
    }

    // Waiver must be server-stamped — never trust client-sent timestamps/IPs
    let createSignedWaiverFor: { memberName: string; ip: string; ua: string } | null = null;
    if (waiverAccepted === true) {
      const existing = await withTenantContext(session.user.tenantId, (tx) =>
        tx.member.findFirst({
          where: { id: memberId, tenantId: session.user.tenantId },
          select: {
            waiverAccepted: true,
            name: true,
            emergencyContactName: true,
            emergencyContactPhone: true,
            emergencyContactRelation: true,
          },
        }),
      );
      if (!existing?.waiverAccepted) {
        const emergencyNameForWaiver =
          typeof emergencyContactName === "string" ? emergencyContactName.trim() : existing?.emergencyContactName?.trim();
        const emergencyPhoneForWaiver =
          typeof emergencyContactPhone === "string" ? emergencyContactPhone.trim() : existing?.emergencyContactPhone?.trim();
        const emergencyRelationForWaiver =
          typeof emergencyContactRelation === "string" ? emergencyContactRelation.trim() : existing?.emergencyContactRelation?.trim();
        if (!emergencyNameForWaiver || !emergencyPhoneForWaiver || !emergencyRelationForWaiver) {
          return NextResponse.json(
            { error: "Emergency contact name, phone, and relation are required before signing." },
            { status: 400 },
          );
        }
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
        updateData.waiverAccepted = true;
        updateData.waiverAcceptedAt = new Date();
        updateData.waiverIpAddress = ip;
        createSignedWaiverFor = {
          memberName: (typeof name === "string" && name.trim()) || existing?.name || "",
          ip,
          ua: req.headers.get("user-agent")?.slice(0, 500) ?? "",
        };
      }
    }

    if (Object.keys(updateData).length > 0) {
      try {
        await withTenantContext(session.user.tenantId, (tx) =>
          tx.member.updateMany({
            where: { id: memberId, tenantId: session.user.tenantId },
            data: updateData,
          }),
        );
      } catch (e: unknown) {
        // @@unique([tenantId, email]) — another account at this gym already
        // uses the requested address (mirrors the staff route's 409).
        if ((e as { code?: string }).code === "P2002") {
          return NextResponse.json(
            { error: "Email already in use", fieldErrors: { email: "That email is already used at this gym." } },
            { status: 409 },
          );
        }
        throw e;
      }

      // Owner-side version history: record from→to for every identity/contact
      // field that actually changed. Notification prefs and onboarding flags
      // are deliberately excluded (noise, not identity). Fire-and-forget —
      // logAudit never fails the request.
      if (before) {
        const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
        const candidates: Array<[string, unknown, unknown]> = [
          ["name", before.name, updateData.name],
          ["email", before.email, updateData.email],
          ["phone", before.phone, updateData.phone],
          ["emergencyContactName", before.emergencyContactName, updateData.emergencyContactName],
          ["emergencyContactPhone", before.emergencyContactPhone, updateData.emergencyContactPhone],
          ["emergencyContactRelation", before.emergencyContactRelation, updateData.emergencyContactRelation],
          ["dateOfBirth", iso(before.dateOfBirth), updateData.dateOfBirth instanceof Date ? iso(updateData.dateOfBirth) : undefined],
        ];
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [field, from, to] of candidates) {
          if (to !== undefined && to !== from) changes[field] = { from: from ?? null, to };
        }
        if (Object.keys(changes).length > 0) {
          const { logAudit } = await import("@/lib/audit-log");
          await logAudit({
            tenantId: session.user.tenantId,
            userId: session.user.id ?? null,
            action: "member.self_update",
            entityType: "Member",
            entityId: memberId,
            metadata: { source: "self", changes },
            req,
          });
        }
      }
    }

    // Append-only legal record of exactly what the member agreed to.
    if (createSignedWaiverFor) {
      try {
        const { buildDefaultWaiverTitle, buildDefaultWaiverContent } = await import("@/lib/default-waiver");
        const signed = await withTenantContext(session.user.tenantId, async (tx) => {
          const tenant = await tx.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { name: true, waiverTitle: true, waiverContent: true },
          });
          return tx.signedWaiver.create({
            data: {
              memberId,
              tenantId: session.user.tenantId,
              titleSnapshot: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
              contentSnapshot: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
              signerName: createSignedWaiverFor!.memberName || null,
              ipAddress: createSignedWaiverFor!.ip,
              userAgent: createSignedWaiverFor!.ua,
            },
          });
        });
        const { logAudit } = await import("@/lib/audit-log");
        await logAudit({
          tenantId: session.user.tenantId,
          userId: null,
          action: "waiver.sign",
          entityType: "Member",
          entityId: memberId,
          metadata: { signedWaiverId: signed.id },
          req,
        });
      } catch {
        // Best-effort — don't fail the user-facing request if logging fails.
      }
    }

    // Optionally create/update MemberRank from onboarding belt selection.
    // Belt rank can only be set during onboarding; post-onboarding changes must
    // come from the staff endpoint /api/members/[id]/rank.
    if (belt && typeof stripes === "number") {
      await withTenantContext(session.user.tenantId, async (tx) => {
        const existing = await tx.member.findFirst({
          where: { id: memberId, tenantId: session.user.tenantId },
          select: { onboardingCompleted: true },
        });
        if (existing?.onboardingCompleted) return;
        const rankSystem = await tx.rankSystem.findFirst({
          where: { tenantId: session.user.tenantId, name: { contains: belt } },
        });
        if (!rankSystem) return;
        await tx.memberRank.upsert({
          where: { memberId_rankSystemId: { memberId, rankSystemId: rankSystem.id } },
          create: { memberId, rankSystemId: rankSystem.id, stripes },
          update: { stripes },
        });
      });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}
