// GET /api/kiosk/[token]/members?q=...
//
// Public-by-design — kiosk URL token IS the auth.
// Returns up to 10 members whose name matches the query (case-insensitive
// substring). Requires q.length >= 2 to prevent dumping the entire roster.
//
// Response intentionally omits PII (email, phone, DOB, medical, payment
// status). Each result carries a short-TTL signed `kioskMemberToken` that
// the kiosk client posts back to the check-in endpoint — so an attacker
// scraping this endpoint cannot enumerate raw memberIds and reuse them.

import { NextResponse } from "next/server";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { signKioskMemberToken } from "@/lib/kiosk-token";

export const runtime = "nodejs";

const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 10;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const ip = getClientIp(req);
  const tokenHash = hashToken(token);
  const rl = await checkRateLimit(`kiosk:lookup:${tokenHash.slice(0, 12)}:${ip}`, 60, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LEN) {
    return NextResponse.json({ members: [] });
  }

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { kioskTokenHash: tokenHash },
      select: { id: true },
    }),
  );
  if (!tenant) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const members = await withTenantContext(tenant.id, (tx) =>
    tx.member.findMany({
      where: {
        tenantId: tenant.id,
        status: { in: ["active", "taster"] },
        name: { contains: q, mode: "insensitive" },
      },
      select: {
        id: true,
        name: true,
        accountType: true,
        memberRanks: {
          orderBy: { rankSystem: { order: "desc" } },
          take: 1,
          select: {
            rankSystem: { select: { name: true, color: true } },
          },
        },
      },
      orderBy: { name: "asc" },
      take: MAX_RESULTS,
    }),
  );

  return NextResponse.json({
    members: members.map((m) => ({
      kioskMemberToken: signKioskMemberToken({ tenantId: tenant.id, memberId: m.id }),
      name: m.name,
      ageGroup: m.accountType, // adult | junior | kids
      beltName: m.memberRanks[0]?.rankSystem.name ?? null,
      beltColor: m.memberRanks[0]?.rankSystem.color ?? null,
    })),
  });
}
