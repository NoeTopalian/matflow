import { NextResponse } from "next/server";

export async function POST(req: Request) {
  const data = await req.json();
  const { gymName, ownerName, email, phone, sport, memberCount, message } = data;

  if (!gymName || !ownerName || !email || !phone || !sport || !memberCount) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  // TODO: Send notification email to hello@matflow.io via Resend
  console.log("[MatFlow] New gym application:", {
    gymName, ownerName, email, phone, sport, memberCount, message,
    submittedAt: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
