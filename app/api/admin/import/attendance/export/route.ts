// GET /api/admin/import/attendance/export?jobId=…&part=N — the source-booking
// ledger one attendance import created or changed, as CSV (owner only), in
// parts of PART_SIZE bookings; ?jobId=…&info=1 says how many parts there are.
//
// Parts, because a host function's RESPONSE is capped at 4.5 MB like its
// request: the ledger of the real Total BJJ export is 4,550,363 bytes in one
// piece (acceptance review, 3 Oct 2026); 5,000 bookings is about 1.5 MB.
//
// One row per booking with what MatFlow did with it, so the owner (or an
// independent check) can reconcile the import against the TeamUp export
// without trusting the screen. Every cell goes through lib/csv (RFC-4180
// quoting and the formula-injection guard); profile columns the import never
// read (address, phone, date of birth, emergency contact) are not in it.

import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { csvDocument } from "@/lib/csv";
import { JOB_SOURCE, LEDGER_SOURCE } from "@/lib/attendance-import";

export const runtime = "nodejs";

const PART_SIZE = 5000;

const HEADER = [
  "Booking key", "Event Starts At (as exported)", "Club date", "Club time", "Offering", "Venue", "Status", "Customer Name", "Customer Email",
  "Booking Method", "Booking Source", "Customer Membership ID", "Membership ID", "Membership Name", "Check-in time",
  "MatFlow member", "Matched by", "MatFlow outcome", "Created by this import", "Last changed by this import",
];

const OUTCOME_WORDS: Record<string, string> = {
  attendance_created: "Attendance recorded",
  attendance_existing: "Already recorded (linked to an existing visit)",
  booking_only: "Booking kept, not attendance",
  future: "Session not yet held",
  pending_person: "Waiting: who is this?",
  pending_offering: "Waiting: which class?",
  pending_venue: "Waiting: which venue?",
  venue_conflict: "Waiting: venue does not match the class",
  pending_conflict: "Waiting: the export contradicts itself",
  staff_removed: "Removed by staff — not recreated",
};

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId")?.trim() ?? "";
  if (!jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  const wantInfo = url.searchParams.get("info") === "1";
  const part = Number(url.searchParams.get("part") ?? "1");
  if (!wantInfo && (!Number.isInteger(part) || part < 1)) return NextResponse.json({ error: "part must be 1 or more" }, { status: 400 });

  const data = await withTenantContext(tenantId, async (tx) => {
    const job = await tx.importJob.findFirst({ where: { id: jobId, tenantId, source: JOB_SOURCE }, select: { id: true, fileName: true } });
    if (!job) return null;
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const where = { tenantId, source: LEDGER_SOURCE, OR: [{ createdByJobId: job.id }, { lastJobId: job.id }] };
    const total = await tx.importedBooking.count({ where });
    if (wantInfo) return { job, rows: [], total, timezone: "" };
    const rows = await tx.importedBooking.findMany({
      where,
      orderBy: [{ startsAt: "asc" }, { bookingKey: "asc" }],
      skip: (part - 1) * PART_SIZE,
      take: PART_SIZE,
      select: {
        bookingKey: true, startsAt: true, startsAtRaw: true, offeringLabel: true, venueLabel: true, rawStatus: true, sourceName: true, sourceEmail: true,
        bookingMethod: true, bookingSource: true, customerMembershipRef: true, membershipRef: true, membershipName: true, checkinAtRaw: true,
        matchMethod: true, disposition: true, createdByJobId: true, lastJobId: true, member: { select: { name: true } },
      },
    });
    return { job, rows, total, timezone: tenant?.timezone || "Europe/London" };
  }, { timeout: 60_000 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parts = Math.max(1, Math.ceil(data.total / PART_SIZE));
  if (wantInfo) return NextResponse.json({ total: data.total, partSize: PART_SIZE, parts });
  if (part > parts) return NextResponse.json({ error: `There are only ${parts} parts.` }, { status: 404 });

  const day = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: data.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const body = csvDocument([
    HEADER,
    ...data.rows.map((r) => [
      r.bookingKey.slice(0, 16), r.startsAtRaw, day.format(r.startsAt), time.format(r.startsAt), r.offeringLabel, r.venueLabel, r.rawStatus,
      r.sourceName, r.sourceEmail, r.bookingMethod, r.bookingSource, r.customerMembershipRef, r.membershipRef, r.membershipName,
      r.checkinAtRaw ?? "Not recorded in the export",
      r.member?.name ?? "", r.matchMethod ?? "", OUTCOME_WORDS[r.disposition] ?? r.disposition,
      r.createdByJobId === data.job.id ? "yes" : "no", r.lastJobId === data.job.id ? "yes" : "no",
    ]),
  ]);

  await logAudit({ tenantId, userId, action: "import.attendance.export", entityType: "ImportJob", entityId: data.job.id, metadata: { rows: data.rows.length, part, parts }, req });
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="attendance-import-${data.job.id.slice(0, 8)}${parts > 1 ? `-part-${part}-of-${parts}` : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
