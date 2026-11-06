/**
 * GET /api/member/timetable — how the club's timetable is laid out, for the members' app.
 *
 * `{ layout: "mat" | "time", mats: [{ id, name }] }`: the split in effect (the
 * club's saved choice, else worked out from its mats — lib/timetable-layout.ts)
 * and the club's mats in the club's order, which is the order of the columns.
 * Read by the member's day beside /api/member/schedule, whose classes carry
 * `matId`.
 *
 * Any signed-in person of the club. Only the caller's own club is ever read.
 * The demo club has no mats and is split by time, without touching the
 * database.
 */
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { listMats, readLayout } from "@/lib/mats-store";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE });
  const tenantId = session.user.tenantId;
  if (tenantId === "demo-tenant") return NextResponse.json({ layout: "time", mats: [] }, { headers: NO_STORE });

  try {
    const body = await withTenantContext(tenantId, async (tx) => {
      const mats = await listMats(tx, tenantId);
      const layout = await readLayout(tx, tenantId);
      return { layout: layout.effective, mats: mats.map((m) => ({ id: m.id, name: m.name })) };
    });
    return NextResponse.json(body, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "Couldn't load the timetable layout." }, { status: 500, headers: NO_STORE });
  }
}
