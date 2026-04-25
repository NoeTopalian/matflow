import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { generateSecret, generateURI, verifySync } from "otplib";
import QRCode from "qrcode";

// GET — generate or re-fetch TOTP secret + QR code
export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { totpSecret: true, totpEnabled: true, email: true },
  });
  if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // If already enabled, don't re-generate
  if (user.totpEnabled && user.totpSecret) {
    const uri = generateURI({ label: user.email, issuer: "MatFlow", secret: user.totpSecret });
    const qrDataUrl = await QRCode.toDataURL(uri);
    return NextResponse.json({ secret: user.totpSecret, qrDataUrl, alreadyEnabled: true });
  }

  const secret = generateSecret();
  await prisma.user.update({
    where: { id: session.user.id },
    data: { totpSecret: secret, totpEnabled: false },
  });

  const uri = generateURI({ label: user.email, issuer: "MatFlow", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json({ secret, qrDataUrl, alreadyEnabled: false });
}

// POST — verify code and enable TOTP
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
    select: { totpSecret: true },
  });
  if (!user?.totpSecret) {
    return NextResponse.json({ error: "TOTP not initialised — call GET first" }, { status: 400 });
  }

  const result = verifySync({ token: code, secret: user.totpSecret });
  if (!result.valid) return NextResponse.json({ error: "Invalid code" }, { status: 400 });

  await prisma.user.update({
    where: { id: session.user.id },
    data: { totpEnabled: true },
  });

  return NextResponse.json({ ok: true });
}
