import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const applySchema = z.object({
  gymName: z.string().min(1).max(120),
  ownerName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(3).max(40),
  sport: z.string().min(1).max(60),
  memberCount: z.string().min(1).max(40),
  message: z.string().max(2000).optional().nullable(),
});

export async function POST(req: Request) {
  // Rate-limit before doing any work — this endpoint is unauthenticated and
  // creates downstream side-effects (DB write + emails). 5/hour/IP is generous
  // enough for legitimate retries while shutting down scripted spam.
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`apply:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many applications from this IP. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = applySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Missing or invalid fields", details: parsed.error.flatten() }, { status: 400 });
  }
  const { gymName, ownerName, email, phone, sport, memberCount, message } = parsed.data;

  const userAgent = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  let applicationId: string | null = null;
  try {
    const created = await prisma.gymApplication.create({
      data: {
        gymName,
        contactName: ownerName,
        email,
        phone,
        discipline: sport,
        memberCount,
        notes: message ?? null,
        ipAddress: ip === "unknown" ? null : ip,
        userAgent,
      },
      select: { id: true },
    });
    applicationId = created.id;
  } catch (e) {
    console.error("[apply] DB write failed", e);
    // Persistence failure shouldn't break the apply flow for the user — still
    // try to send the internal notification so the application isn't dropped.
  }

  // Internal notification — comma-separated list of admin emails. Defaults
  // to the public hello@ address when unset so installs don't silently drop.
  const internalRecipients = (process.env.MATFLOW_APPLICATIONS_TO ?? "hello@matflow.io")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Fire-and-forget both emails in parallel — the user gets the success page
  // either way, and EmailLog records every attempt.
  await Promise.allSettled([
    sendEmail({
      tenantId: "_system",
      templateId: "application_received",
      to: email,
      vars: { contactName: ownerName, gymName },
    }),
    ...internalRecipients.map((to) =>
      sendEmail({
        tenantId: "_system",
        templateId: "application_internal",
        to,
        vars: {
          gymName,
          contactName: ownerName,
          email,
          phone: phone ?? "",
          discipline: sport,
          memberCount,
          notes: message ?? "",
        },
      }),
    ),
  ]);

  return NextResponse.json({ ok: true, id: applicationId });
}
