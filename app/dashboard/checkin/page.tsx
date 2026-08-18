import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import AdminCheckin from "@/components/dashboard/AdminCheckin";

export type CheckinClassInstance = {
  id: string;
  name: string;
  coachName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  maxCapacity: number | null;
  color: string | null;
};

export type CheckinMember = {
  id: string;
  name: string;
  membershipType: string | null;
  rankName: string | null;
  rankColor: string | null;
  checkedIn: boolean;
  // feat/member-profile-pictures Track A Phase A5: drives register-row avatar.
  profilePictureUrl: string | null;
};

async function getTodayInstances(tenantId: string): Promise<CheckinClassInstance[]> {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);

  const instances = await withTenantContext(tenantId, (tx) =>
    tx.classInstance.findMany({
      where: {
        class: { tenantId },
        date: { gte: start, lte: end },
        isCancelled: false,
      },
      include: { class: true },
      orderBy: { startTime: "asc" },
    }),
  );

  return instances.map((inst) => ({
    id: inst.id,
    name: inst.class.name,
    coachName: inst.class.coachName,
    location: inst.class.location,
    startTime: inst.startTime,
    endTime: inst.endTime,
    maxCapacity: inst.class.maxCapacity,
    color: inst.class.color,
  }));
}

async function getMembersForInstance(instanceId: string, tenantId: string): Promise<CheckinMember[]> {
  const [members, attendances] = await withTenantContext(tenantId, (tx) =>
    Promise.all([
      tx.member.findMany({
        where: { tenantId, status: { in: ["active", "taster"] } },
        // Only the fields the picker actually renders. Skips the bulk of
        // the Member row (waiver text, contact details, totp secrets, etc.).
        select: {
          id: true,
          name: true,
          membershipType: true,
          memberRanks: {
            select: {
              rankSystem: { select: { name: true, color: true } },
            },
            orderBy: { achievedAt: "desc" },
            take: 1,
          },
          // feat/member-profile-pictures Track A Phase A5: pull profile photo
          // alongside ranks so the register avatar is filled. Partial unique
          // index guarantees ≤1 matching row, so take:1 is exact.
          photos: {
            where: { kind: "profile" },
            select: { url: true },
            take: 1,
          },
        },
        orderBy: { name: "asc" },
      }),
      tx.attendanceRecord.findMany({
        where: { tenantId, classInstanceId: instanceId },
        select: { memberId: true },
      }),
    ]),
  );

  const checkedInIds = new Set(attendances.map((a) => a.memberId));

  return members.map((m) => ({
    id: m.id,
    name: m.name,
    membershipType: m.membershipType,
    rankName: m.memberRanks[0]?.rankSystem.name ?? null,
    rankColor: m.memberRanks[0]?.rankSystem.color ?? null,
    checkedIn: checkedInIds.has(m.id),
    profilePictureUrl: m.photos[0]?.url ?? null,
  }));
}

export default async function CheckinPage({
  searchParams,
}: {
  searchParams: Promise<{ class?: string }>;
}) {
  const { class: classIdParam } = await searchParams;
  const { session } = await requireRole(["owner", "manager", "admin"]);

  let initialMembers: CheckinMember[] = [];
  let initialInstanceId: string | null = null;

  // UI-RULES §7: unguarded, and this one matters most — it is the front-desk
  // screen. Catching turned every database failure into "no class on now", so
  // the desk stops checking members in and nobody learns why. The throw now
  // reaches app/dashboard/error.tsx, which says so and offers a retry.
  const [instances, activeClassIds]: [CheckinClassInstance[], string[]] = await Promise.all([
    getTodayInstances(session!.user.tenantId),
    withTenantContext(session!.user.tenantId, (tx) =>
      tx.class
        .findMany({
          where: { tenantId: session!.user.tenantId, isActive: true, deletedAt: null },
          select: { id: true },
        })
        .then((rows) => rows.map((r) => r.id)),
    ),
  ]);

  if (instances.length > 0) {
    let chosen: (typeof instances)[0] | null = null;

    if (classIdParam) {
      const now = new Date();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setHours(23, 59, 59, 999);
      // Also unguarded: `findFirst` returning null is the real "no instance
      // today for that class", and only that should reach the empty state.
      // The old catch here let a failed lookup impersonate it.
      const matched = await withTenantContext(session!.user.tenantId, (tx) =>
        tx.classInstance.findFirst({
          where: {
            classId: classIdParam,
            class: { tenantId: session!.user.tenantId },
            date: { gte: start, lte: end },
            isCancelled: false,
          },
        }),
      );
      if (matched) {
        chosen = instances.find((i) => i.id === matched.id) ?? null;
      }
    }

    // Only fall back to instances[0] when no ?class= param was given
    if (!chosen && !classIdParam) chosen = instances[0];

    if (chosen) {
      initialInstanceId = chosen.id;
      initialMembers = await getMembersForInstance(chosen.id, session!.user.tenantId);
    }
    // chosen === null: ?class= was given but no today's instance found → renders empty state
  }

  return (
    <AdminCheckin
      instances={instances}
      initialInstanceId={initialInstanceId}
      initialMembers={initialMembers}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
      activeClassIds={activeClassIds}
    />
  );
}
