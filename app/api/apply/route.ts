import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export async function POST(req: Request) {
  // Sprint 5 US-505: rate-limit before doing any work — this endpoint is
  // unauthenticated and creates downstream side-effects (email notification,
  // eventually tenant creation). 5 attempts per hour per IP is generous enough
  // for legitimate retries while shutting down scripted spam.
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`apply:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many applications from this IP. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const data = await req.json();
  const { gymName, ownerName, email, phone, sport, memberCount, message } = data;

  if (!gymName || !ownerName || !email || !phone || !sport || !memberCount) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  // TODO: Send notification email to hello@matflow.io via Resend
  console.log("[MatFlow] New gym application received");

  return NextResponse.json({ ok: true });
}
