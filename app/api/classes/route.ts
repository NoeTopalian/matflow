import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination } from "@/lib/pagination";
import { classCreateSchema as createSchema } from "@/lib/schemas/class";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { buildInstanceRows, ROLLING_WINDOW_DAYS } from "@/lib/class-instances";
import { clubDayMarker, scheduleStartMarker } from "@/lib/today-sessions";
import { usableTimezone } from "@/lib/class-time";
import { classRefError, CLASS_REF_ERRORS, isMatForeignKeyError, isMatNameClash } from "@/lib/class-refs";
import { OPEN_RULES, rulesAfterEdit } from "@/lib/booking-eligibility";
import { readRankOrders, restrictionPreview } from "@/lib/booking-eligibility-db";
import { LOCATION_ERRORS, checkLocationName, lockClubMats } from "@/lib/mats";
import { matForLocation } from "@/lib/mats-store";
import { refuseSupportSessionUnlessEdit } from "@/lib/support-session";
import { CATEGORY_ERRORS, CATEGORY_REF_SELECT, ClassCategoryRefusal, categoryFields, categoryIdToWrite, classCategoryDbError } from "@/lib/class-category-store";

/** A tier vanished between the club check and the write: roll the class back. */
class TierRefError extends Error {}
/** The mat is not this club's, or was removed between the club check and the write. */
class MatRefError extends Error {}
/** A new Location would be the club's thirteenth mat: roll the class back. */
class MatLimitError extends Error {}

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Hard-cap response size to avoid unbounded reads. Cursor support is opt-in
  // via ?cursor/?take query params; default behaviour returns up to 100 active
  // classes — sufficient for the largest gym we anticipate without forcing
  // existing callers (which expect an array) to change.
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  try {
    const classes = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findMany({
        // RULES §5: soft-delete columns must be filtered by every reader.
        where: { tenantId: session.user.tenantId, isActive: true, deletedAt: null },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
          // T6a: the memberships that include the class ([] = everyone).
          allowedTiers: { select: { tier: { select: { id: true, name: true, isActive: true } } } },
        },
        orderBy: { name: "asc" },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
      }),
    );
    // Lane 1 iter-2 L1-I2-S-02 [High]: per-tenant class listing.
    return NextResponse.json(classes.map(({ allowedTiers, ...c }) => ({ ...c, allowedTiers: allowedTiers.map((t) => t.tier) })), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json([], {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const support = refuseSupportSessionUnlessEdit(session); if (support) return support; // view refused; an EDIT session may create and edit classes (SUPPORT_EDIT_MUTATION_ALLOWLIST)

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  // `allowedTierIds` is destructured, never spread into `class.create`: it is
  // written as ClassMembershipTier rows in the same transaction.
  // `matName` is resolved to a mat (or a typed place) inside the write
  // transaction, never written as a column.
  // `categoryId` / `category` (an old key) are resolved to the club's category
  // inside the write transaction, then written as `categoryId` only.
  const { schedules, roster, allowedTierIds, matName, categoryId: categoryIdIn, category: categoryKeyIn, ...classData } = parsed.data;
  if (categoryIdIn !== undefined && categoryKeyIn !== undefined) {
    return NextResponse.json({ error: CATEGORY_ERRORS.both, reason: "category" }, { status: 400 });
  }

  // The class form's Location by name.
  let locationName: string | null = null;
  if (matName !== undefined) {
    if (classData.matId) return NextResponse.json({ error: LOCATION_ERRORS.both, reason: "location" }, { status: 400 });
    const checked = checkLocationName(matName);
    if (!checked.ok) return NextResponse.json({ error: checked.error, reason: "location" }, { status: 400 });
    locationName = checked.name;
  }

  // Roster mode and rank gates are mutually exclusive — the same rule the PATCH
  // route enforces by clearing one when the other is set. At create time there
  // is nothing to clear, so naming both is a refusal rather than a silent
  // winner: the owner finds out now, not when the gate they thought they set
  // turns out not to be there.
  if (roster && roster.length > 0 && (classData.requiredRankId || classData.maxRankId)) {
    return NextResponse.json(
      { error: "A class uses either a rank gate or a roster, not both. Clear the rank fields to use a roster." },
      { status: 400 },
    );
  }

  // ADR-001 D2: a location id must be one of this club's; a foreign or stale
  // id is refused, never silently dropped (a class that quietly lands at "all
  // locations" is a timetable lie). Finding E-2 (6 Oct 2026): the belt and
  // coach ids follow the same rule — they were written unchecked, so gym A
  // could attach gym B's belt or coach and read their names back.
  if (
    classData.locationId || classData.matId || classData.requiredRankId || classData.maxRankId || classData.coachUserId ||
    (allowedTierIds && allowedTierIds.length > 0)
  ) {
    const refError = await withTenantContext(session.user.tenantId, (tx) =>
      classRefError(tx, session.user.tenantId, { ...classData, allowedTierIds }),
    );
    if (refError) return NextResponse.json({ error: refError }, { status: 400 });
  }

  // D2: `?dryRun=1` is the owner's restriction preview for a new class — who
  // its squad list, rank gate and membership list would turn away (members
  // of this club, without guardian or payer accounts, grouped by reason).
  // Nothing is written. A new class has no bookings yet.
  if (new URL(req.url).searchParams.get("dryRun") === "1") {
    const tenantId = session.user.tenantId;
    const restriction = await withTenantContext(tenantId, async (tx) => {
      const rosterIds = roster && roster.length > 0
        ? (await tx.member.findMany({ where: { id: { in: roster.map((r) => r.memberId) }, tenantId, archivedAt: null }, select: { id: true } })).map((m) => m.id)
        : [];
      const orders = await readRankOrders(tx, tenantId, [classData.requiredRankId, classData.maxRankId]);
      const after = rulesAfterEdit(OPEN_RULES, {
        roster: rosterIds.length > 0 ? rosterIds : undefined,
        namesRank: false,
        requiredRankOrder: classData.requiredRankId ? (orders.get(classData.requiredRankId) ?? null) : null,
        maxRankOrder: classData.maxRankId ? (orders.get(classData.maxRankId) ?? null) : null,
        allowedTierIds: allowedTierIds ?? [],
      });
      return (await restrictionPreview(tx, tenantId, { classId: null, before: OPEN_RULES, after })).preview;
    });
    return NextResponse.json({ dryRun: true, restriction });
  }

  try {
    const { cls, instancesCreated, tierIdsWritten, tiersWritten, rosterWritten, locationAdded } = await withTenantContext(session.user.tenantId, async (tx) => {
      // A class created on a mat: the club's mats lock FIRST (so the mat
      // cannot be renamed or removed under this write), then the mat's name,
      // which becomes the class's place whatever was typed (the write-through
      // rule, lib/mats.ts). The same lock when a mat is named by name
      // (`matName`). A class that names no mat takes no mats lock.
      let place: { matId: string | null; location: string } | null = null;
      let locationAdded: { id: string; name: string; classIds: string[] } | null = null;
      if (classData.matId) {
        await lockClubMats(tx, session.user.tenantId);
        const mat = await tx.mat.findFirst({ where: { id: classData.matId, tenantId: session.user.tenantId }, select: { name: true } });
        if (!mat) throw new MatRefError();
        place = { matId: classData.matId, location: mat.name };
      } else if (locationName !== null) {
        // A Location by name: the club's mat of that name, added here when
        // there is none (same lock, same transaction as the class).
        await lockClubMats(tx, session.user.tenantId);
        const found = await matForLocation(tx, session.user.tenantId, locationName, { userId: session.user.id, req });
        if (found.kind === "limit") throw new MatLimitError();
        place = { matId: found.id, location: found.name };
        if (found.created) locationAdded = { id: found.id, name: found.name, classIds: found.classIds };
      }
      // The club's zone is needed BEFORE the write, not only for the window
      // below: `startDate` is a day marker and the club's calendar date is what
      // it must say (see `scheduleStartMarker`).
      const tenant = await tx.tenant.findUnique({ where: { id: session.user.tenantId }, select: { timezone: true } });
      const timeZone = usableTimezone(tenant?.timezone);
      const now = new Date();
      const categoryId = await categoryIdToWrite(tx, session.user.tenantId, { categoryId: categoryIdIn, category: categoryKeyIn }, null);
      const cls = await tx.class.create({
        data: {
          tenantId: session.user.tenantId,
          ...classData,
          ...(categoryId !== undefined ? { categoryId } : {}),
          ...(place !== null ? place : {}),
          schedules: {
            create: schedules.map((s: typeof schedules[number]) => ({
              dayOfWeek: s.dayOfWeek,
              startTime: s.startTime,
              endTime: s.endTime,
              startDate: scheduleStartMarker(s.startDate, now, timeZone),
              endDate: s.endDate ? new Date(s.endDate) : null,
            })),
          },
        },
        include: {
          schedules: { orderBy: [{ dayOfWeek: "asc" }, { startTime: "asc" }] },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
          categoryRef: { select: CATEGORY_REF_SELECT },
        },
      });
      // T6a: the memberships that include the class, in the same transaction
      // so the class never exists open when the owner meant it restricted.
      // Ids were checked against the club above; re-read here, in the write
      // transaction, so a tier deleted in between rolls the create back.
      let tierIdsWritten: string[] = [];
      // The same {id, name, isActive} shape GET and PATCH return as
      // `allowedTiers`, so the timetable's row (and the form reopened on it)
      // shows the list without a refresh.
      let tiersWritten: { id: string; name: string; isActive: boolean }[] = [];
      let rosterWritten: { memberId: string; name: string }[] = [];
      if (allowedTierIds && allowedTierIds.length > 0) {
        const tiers = await tx.membershipTier.findMany({
          where: { id: { in: allowedTierIds }, tenantId: session.user.tenantId },
          select: { id: true, name: true, isActive: true },
        });
        if (tiers.length !== allowedTierIds.length) throw new TierRefError();
        await tx.classMembershipTier.createMany({
          data: tiers.map((t) => ({
            tenantId: session.user.tenantId,
            classId: cls.id,
            tierId: t.id,
            createdByUserId: session.user.id,
          })),
          skipDuplicates: true,
        });
        tierIdsWritten = tiers.map((t) => t.id).sort();
        tiersWritten = tiers;
      }
      // The allow-list, in the same transaction as the class: a class that
      // exists with nobody on its roster is a class anyone can check into, so
      // the two must commit together. The ticked ids are re-read under the
      // tenant context first — an id from another gym is not written, it is
      // simply absent, exactly as the roster POST route refuses one.
      if (roster && roster.length > 0) {
        const ours = await tx.member.findMany({
          where: { id: { in: roster.map((r) => r.memberId) }, tenantId: session.user.tenantId, archivedAt: null },
          select: { id: true, name: true },
        });
        // Reported back in the timetable page's shape, so the new class
        // reopens as the squad it is rather than as open to everyone.
        rosterWritten = ours.map((m) => ({ memberId: m.id, name: m.name }));
        if (ours.length > 0) {
          await tx.classRoster.createMany({
            data: ours.map((m) => ({
              tenantId: session.user.tenantId,
              classId: cls.id,
              memberId: m.id,
              addedByUserId: session.user.id,
            })),
            skipDuplicates: true,
          });
        }
      }

      // A class exists on the timetable the moment it is created, not the
      // morning after the cron (which on production has never run). Same
      // window and spelling as the PATCH route and the cron, so the three
      // cannot fight: idempotent on @@unique([classId, date, startTime]).
      // Noe, 18 Sep 2026: "it doesn't come up with the option to sign people
      // into classes happening at this moment."
      const rows = buildInstanceRows([{ id: cls.id, schedules: cls.schedules }], {
        from: clubDayMarker(now, timeZone),
        days: ROLLING_WINDOW_DAYS,
      });
      const minted = rows.length > 0 ? await tx.classInstance.createMany({ data: rows, skipDuplicates: true }) : { count: 0 };
      return { cls, instancesCreated: minted.count, tierIdsWritten, tiersWritten, rosterWritten, locationAdded };
    });
    // `categoryOldKey`: Release B's activation signal (docs/readiness/CLASS-CATEGORIES-RELEASE-B-2026-11-12.md §3.2),
    // set when the old key was sent: an old page, or this release's form in a club with no category rows yet. That
    // row is written durably (awaited) rather than best-effort; a failure to write it is logged, never an error.
    const oldKey = categoryKeyIn !== undefined;
    try {
      await logAudit({
        ...(oldKey ? { durable: true } : {}),
        tenantId: session.user.tenantId,
        userId: session.user.id,
        action: "class.created",
        entityType: "Class",
        entityId: cls.id,
        metadata: { name: cls.name, instancesCreated, allowedTierIds: { before: [], after: tierIdsWritten }, ...(oldKey ? { categoryOldKey: true } : {}) },
        req,
      });
    } catch (e) {
      console.error("[class-category] old-page audit row not written", e instanceof Error ? e.message : e);
    }
    const { categoryRef, ...created } = cls;
    return NextResponse.json(
      // `locationAdded`: the mat this save added from a typed Location, the club's other classes it took with it, and
      // when the save was done (after the commit), so the page can tell a list read before it from one read after.
      { ...created, ...categoryFields(categoryRef), instancesCreated, allowedTierIds: tierIdsWritten, allowedTiers: tiersWritten, roster: rosterWritten, locationAdded: locationAdded ? { ...locationAdded, savedAt: new Date().toISOString() } : null },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ClassCategoryRefusal) {
      return NextResponse.json({ error: e.message, reason: "category" }, { status: e.status });
    }
    const categoryRefused = classCategoryDbError(e);
    if (categoryRefused) return NextResponse.json({ error: categoryRefused.error, reason: "category" }, { status: categoryRefused.status });
    if (e instanceof TierRefError) {
      return NextResponse.json({ error: CLASS_REF_ERRORS.tier }, { status: 400 });
    }
    if (e instanceof MatLimitError) {
      return NextResponse.json({ error: LOCATION_ERRORS.limit, reason: "location" }, { status: 409 });
    }
    // The unique (club, name key) index is the backstop behind the mats lock.
    if (locationName !== null && isMatNameClash(e)) {
      return NextResponse.json({ error: "Couldn't save the location. Try again.", reason: "location" }, { status: 409 });
    }
    // The mat went between the club check and the write, or the foreign key refused it.
    if (e instanceof MatRefError || isMatForeignKeyError(e)) {
      return NextResponse.json({ error: CLASS_REF_ERRORS.mat }, { status: 400 });
    }
    return NextResponse.json({ error: "Failed to create class" }, { status: 500 });
  }
}
