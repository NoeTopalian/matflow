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
      select: { purpose: true, used: true, expiresAt: true },
    }),
  );

  if (!token || token.purpose !== "waiver_open") {
    return NextResponse.json({ signed: false });
  }

  // Treat expired-but-unsigned as not-signed (kiosk should show timeout)
  if (!token.used && token.expiresAt < new Date()) {
    return NextResponse.json({ signed: false, expired: true });
  }

  return NextResponse.json({ signed: token.used });
}
