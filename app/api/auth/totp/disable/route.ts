import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { verifySync } from "otplib";

export async function POST(req: Request) {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { code } = body as { code?: string };
  if (!code || !/^\d{6}$/.test(code)) {
    return NextResponse.json({ error: "Invalid code format" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { totpSecret: true, totpEnabled: true },
  });

  if (!user?.totpSecret || !user.totpEnabled) {
    return NextResponse.json({ error: "TOTP not enabled" }, { status: 400 });
  }

  const result = verifySync({ token: code, secret: user.totpSecret });
  if (!result.valid) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

  // Disable TOTP and bump sessionVersion to invalidate all existing sessions
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      totpEnabled: false,
      totpSecret: null,
      sessionVersion: { increment: 1 },
    },
  });

  return NextResponse.json({ ok: true });
}
