// Task 3b — `skipDuplicates` was a lie on ClassInstance.
//
// Both generation routes call createMany({ skipDuplicates: true }). Prisma
// compiles that to ON CONFLICT DO NOTHING, which needs a UNIQUE constraint to
// conflict against — and ClassInstance had none, only @@index([classId, date])
// and @@index([date, isCancelled]). So the flag was decorative, and the only
// real dedup was a read-then-filter inside a READ COMMITTED transaction: two
// concurrent clicks, or the per-class button firing alongside the global one,
// both read "not present" and both insert.
//
// A duplicated occurrence splits a class's register in two — half the gym
// checks into one row, half into the other — and the member schedule joins by
// `${classId}-${startTime}` and picks whichever the Map happened to keep.
//
// These assertions need a real Postgres because the thing under test IS the
// constraint. Mode A (Neon test branch + tests/setup-test-db.ts gate); skips if
// DATABASE_URL is unset.

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

const SLOT = {
  date: new Date("2031-06-10T00:00:00.000Z"),
  startTime: "18:00",
  endTime: "19:00",
};

describe.skipIf(!HAS_DB)("ClassInstance (classId, date, startTime) is unique", () => {
  let tenantId: string;
  let classId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: `Uniq ${STAMP}`, slug: `uniq-${STAMP}` },
      });
      tenantId = tenant.id;
      const cls = await tx.class.create({
        data: { tenantId, name: "Fundamentals", duration: 60 },
      });
      classId = cls.id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classInstance.deleteMany({ where: { classId } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("rejects a second row for the same class, date and start time", async () => {
    await withRlsBypass((tx) => tx.classInstance.create({ data: { classId, ...SLOT } }));

    // Before the migration this simply inserted a second row.
    await expect(
      withRlsBypass((tx) => tx.classInstance.create({ data: { classId, ...SLOT } })),
    ).rejects.toMatchObject({ code: "P2002" });

    const count = await withRlsBypass((tx) =>
      tx.classInstance.count({ where: { classId, date: SLOT.date, startTime: SLOT.startTime } }),
    );
    expect(count).toBe(1);
  });

  it("makes createMany({ skipDuplicates: true }) actually skip", async () => {
    // The row from the previous case is still there; this is the generation
    // routes' exact call shape.
    const res = await withRlsBypass((tx) =>
      tx.classInstance.createMany({ data: [{ classId, ...SLOT }], skipDuplicates: true }),
    );
    expect(res.count).toBe(0);

    const count = await withRlsBypass((tx) =>
      tx.classInstance.count({ where: { classId, date: SLOT.date, startTime: SLOT.startTime } }),
    );
    expect(count).toBe(1);
  });

  it("closes the TOCTOU: two concurrent generations leave exactly one row", async () => {
    const slot = { ...SLOT, startTime: "20:00" };
    const generate = () =>
      withRlsBypass((tx) =>
        tx.classInstance.createMany({ data: [{ classId, ...slot }], skipDuplicates: true }),
      );

    // The per-class button and the "Generate 4 weeks" button, pressed together.
    // Both transactions read "not present"; without the constraint both then
    // inserted. With it, one inserts and the other's ON CONFLICT DO NOTHING
    // waits on the index entry and no-ops.
    const [a, b] = await Promise.all([generate(), generate()]);
    expect(a.count + b.count).toBe(1);

    const count = await withRlsBypass((tx) =>
      tx.classInstance.count({ where: { classId, date: slot.date, startTime: slot.startTime } }),
    );
    expect(count).toBe(1);
  });

  it("still allows two different start times on the same day", async () => {
    // The constraint must not collapse a club that runs a morning and an
    // evening session of the same class.
    await withRlsBypass((tx) =>
      tx.classInstance.create({
        data: { classId, date: SLOT.date, startTime: "07:00", endTime: "08:00" },
      }),
    );
    const count = await withRlsBypass((tx) =>
      tx.classInstance.count({ where: { classId, date: SLOT.date } }),
    );
    expect(count).toBe(3); // 18:00, 20:00, 07:00
  });
});
