// T6b scope item 8 / acceptance 8: archiving keeps a class's history, so an
// attendance-history import treats an ARCHIVED class as a match target:
//  - the club inputs include archived classes (not filtered on deletedAt);
//  - an owner mapping an offering to an archived class is accepted, rather
//    than told "That class is not in this club." (which was false);
//  - the planner lands that offering's history on the archived class instead
//    of creating a new historical class;
//  - the suggestion prefers a class on the timetable, and falls back to a
//    paused or archived class of the same name.

import { describe, it, expect, vi } from "vitest";
import { loadClubInputs, saveDecisions } from "@/lib/attendance-import";
import { parseAttendanceCsv, planAttendanceImport, type RosterClass } from "@/lib/importers/attendance";

const HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const ROW = "Ada Lovelace,ada@example.test,2025-10-04T09:00:00+01:00,Adults Gi,Main Mat,,Online,CM-1,MS-1,Adults Unlimited,Web,Attended,,,,,,,GB,,,,,,,";

function planWith(classes: RosterClass[], offeringDecision?: { action: "class"; targetId: string }) {
  const rows = parseAttendanceCsv([HEADER, ROW].join("\n")).rows;
  return planAttendanceImport(rows, {
    timezone: "Europe/London",
    now: new Date("2025-11-01T00:00:00Z"),
    members: [{ id: "m_ada", name: "Ada Lovelace", email: "ada@example.test", externalRef: null, createdAt: "2020-01-01T00:00:00Z" }] as never,
    classes,
    locations: [{ id: "loc_main", name: "Main Mat" }],
    decisions: {
      person: {},
      offering: offeringDecision ? { "Adults Gi": offeringDecision } : {},
      venue: { "Main Mat": { action: "location", targetId: "loc_main" } },
    },
    isSynthesisedEmail: () => false,
  });
}

const ARCHIVED_GI: RosterClass = { id: "c_old_gi", name: "Adults Gi", isActive: false, historical: false, archived: true, locationId: null };

describe("T6b — archived classes in the attendance-history import", () => {
  it("loadClubInputs reads every class of the club, archived ones included, and flags them", async () => {
    const classFindMany = vi.fn(async () => [
      { id: "c_live", name: "No-Gi", isActive: true, deletedAt: null, sourceImportJobId: null, locationId: null },
      { id: "c_old_gi", name: "Adults Gi", isActive: false, deletedAt: new Date("2026-10-01T00:00:00Z"), sourceImportJobId: null, locationId: null },
    ]);
    const tx = {
      tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
      member: { findMany: vi.fn(async () => []) },
      class: { findMany: classFindMany },
      location: { findMany: vi.fn(async () => []) },
      importSourceMapping: { findMany: vi.fn(async () => []) },
      $queryRaw: vi.fn(async () => []),
    };
    const inputs = await loadClubInputs(tx as never, "t1");
    const where = (classFindMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toEqual({ tenantId: "t1" });
    expect(inputs.classes.find((c) => c.id === "c_old_gi")).toMatchObject({ archived: true, isActive: false, historical: false });
    expect(inputs.classes.find((c) => c.id === "c_live")).toMatchObject({ archived: false, isActive: true });
  });

  it("saveDecisions accepts an archived class as a mapping target (no deletedAt filter), tenant-scoped", async () => {
    const count = vi.fn(async () => 1);
    const upsert = vi.fn(async () => ({ id: "map1" }));
    const tx = {
      class: { count },
      importSourceMapping: { findUnique: vi.fn(async () => null), upsert },
    };
    // The provenance write after the upsert is not faked here (it is covered by
    // the import suites); what matters is that validation let the archived
    // class through and the mapping was written to it.
    const err = await saveDecisions(tx as never, "t1", "u1", [
      { kind: "offering", sourceKey: "Adults Gi", action: "class", targetId: "c_old_gi" } as never,
    ]).catch(() => null);
    expect(err).not.toBe("That class is not in this club.");
    expect(count).toHaveBeenCalledWith({ where: { id: "c_old_gi", tenantId: "t1" } });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ tenantId: "t1", action: "class", targetId: "c_old_gi" }) }),
    );
  });

  it("saveDecisions still refuses a class id that is not this club's", async () => {
    const tx = { class: { count: vi.fn(async () => 0) } };
    const err = await saveDecisions(tx as never, "t1", "u1", [
      { kind: "offering", sourceKey: "Adults Gi", action: "class", targetId: "c_foreign" } as never,
    ]);
    expect(err).toBe("That class is not in this club.");
  });

  it("acceptance 8: history mapped to an archived class lands on it, not on a new historical class", () => {
    const b = planWith([ARCHIVED_GI], { action: "class", targetId: "c_old_gi" }).bookings[0];
    expect(b.classKey).toBe("c_old_gi");
    expect(b.classKey?.startsWith("new:")).toBe(false);
  });

  it("the suggestion falls back to an archived class of the same name when none is on the timetable", () => {
    const offering = planWith([ARCHIVED_GI]).offerings.find((o) => o.label === "Adults Gi");
    expect(offering?.suggestedClassId).toBe("c_old_gi");
  });

  it("a class on the timetable is still preferred over an archived one of the same name", () => {
    const live: RosterClass = { id: "c_gi", name: "Adults Gi", isActive: true, historical: false, locationId: null };
    const offering = planWith([ARCHIVED_GI, live]).offerings.find((o) => o.label === "Adults Gi");
    expect(offering?.suggestedClassId).toBe("c_gi");
  });

  it("an imported historical class is never suggested", () => {
    const hist: RosterClass = { id: "c_hist", name: "Adults Gi", isActive: false, historical: true, locationId: null };
    const offering = planWith([hist]).offerings.find((o) => o.label === "Adults Gi");
    expect(offering?.suggestedClassId).toBeNull();
  });
});
