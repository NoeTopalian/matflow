import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";

const querySchema = z.object({
  tokenId: z.string().min(1).max(50),
});

export async function GET(req: Request) {
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`waiver:kiosk-status:${ip}`, 120, 60_000);
  if (!rl.allowed) {
    return NextResponse.json({ error: "Rate limited" }, { status: 429 });
  }

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({ tokenId: url.searchParams.get("tokenId") });
  if (!parsed.success) {
    return NextResponse.json({ error: "tokenId required" }, { status: 400 });
  }

  const token = await withRlsBypass((tx) =>
    tx.magicLinkToken.findUnique({
      where: { id: parsed.data.tokenId },
      select: { purpose: true, used: true, expiresAt: true, email: true, tenantId: true },
    }),
  );

  if (!token || token.purpose !== "waiver_open") {
    return NextResponse.json({ signed: false });
  }

  // Treat expired-but-unsigned as not-signed (kiosk should show timeout)
  if (!token.used && token.expiresAt < new Date()) {
    return NextResponse.json({ signed: false, expired: true });
  }

  if (!token.used) {
    return NextResponse.json({ signed: false });
  }

  // `used` alone is not a signature. Minting a fresh waiver link retires every
  // earlier one by setting `used` too (kiosk-request, members/[id]/waiver-link),
  // and the kiosk checks the member in the moment this answers "signed" with
  // no server-side waiver check behind it. So "signed" means the member's own
  // waiver flag flipped — which is what a real signature writes alongside
  // `used` (app/api/waiver/open). Scoped to the token's tenant and address.
  const member = await withRlsBypass((tx) =>
    tx.member.findFirst({
      where: { tenantId: token.tenantId, email: token.email },
      select: { waiverAccepted: true },
    }),
  );

  return NextResponse.json({ signed: member?.waiverAccepted === true });
}
