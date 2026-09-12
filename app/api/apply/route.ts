import { NextResponse } from "next/server";
import { z } from "zod";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { sendEmail } from "@/lib/email";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { notesField } from "@/lib/schemas/notes-sanitiser";

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const applySchema = z.object({
  gymName: z.string().min(1).max(120),
  ownerName: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(3).max(40),
  sport: z.string().min(1).max(60),
  memberCount: z.string().min(1).max(40),
  // feat/member-tickable-notes Phase 1b: shared sanitiser — see lib/schemas/notes-sanitiser.ts
  message: notesField(2000),
});

export async function POST(req: Request) {
  // Rate-limit before doing any work — this endpoint is unauthenticated and
  // creates downstream side-effects (DB write + emails). 5/hour/IP is generous
  // enough for legitimate retries while shutting down scripted spam.
  const ip = getClientIp(req);
  const rl = await checkRateLimit(`apply:${ip}`, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS, { failClosed: true });
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
    // GymApplication has no tenantId — it's a public funnel before any tenant
    // exists. Bypass is intentional and correct here.
    const created = await withRlsBypass((tx) =>
      tx.gymApplication.create({
        data: {
          gymName,
          contactName: ownerName,
          email,
          phone,
          discipline: sport,
          memberCount,
          // notesField() already returns either a trimmed/sanitised string or null.
          notes: message,
          ipAddress: ip === "unknown" ? null : ip,
          userAgent,
        },
        select: { id: true },
      }),
    );
    applicationId = created.id;
  } catch (e) {
    console.error("[apply] DB write failed", e);
    // Persistence failure shouldn't break the apply flow for the user — still
    // try to send the internal notification so the application isn't dropped.
  }

  // Internal notification — comma-separated list of admin emails. The unset
  // default must be a mailbox that actually delivers (hello@matflow.io was on
  // an unowned domain — applications would have vanished into a void).
  const internalRecipients = (process.env.MATFLOW_APPLICATIONS_TO ?? "noetopalian@gmail.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // The results are INSPECTED, not discarded.
  //
  // This was `Promise.allSettled([...])` with the outcome thrown away and a
  // flat `{ ok: true }` returned, so a prospective customer could apply and
  // nobody at MatFlow would ever learn they had. For a business whose whole
  // problem is winning its first gyms, that is the most expensive silent
  // failure in the product.
  //
  // The two emails are not equally important and are no longer treated as if
  // they were. The applicant's confirmation is a courtesy: if it fails the lead
  // is still safe, because the GymApplication row is already committed above.
  // The INTERNAL notification is the one that decides whether a human ever
  // hears about it.
  const [applicantResult, ...internalResults] = await Promise.allSettled([
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

  const reachedAHuman = internalResults.some(
    (r) => r.status === "fulfilled" && r.value.ok,
  );

  if (applicantResult.status !== "fulfilled" || !applicantResult.value.ok) {
    // Not fatal — logged so it is greppable rather than invisible.
    console.error("[apply] applicant confirmation did not send", { applicationId, email });
  }

  if (!reachedAHuman) {
    // Distinctive marker so a log drain or a grep finds this immediately; it is
    // the difference between a lost lead and a chased one.
    console.error(
      "[apply] LEAD NOT NOTIFIED — no internal recipient was reached",
      { applicationId, gymName, email, recipients: internalRecipients.length },
    );
    // 502, not 200. The application IS saved and the response says so, but
    // telling someone "we'll be in touch" when nothing can reach us is the
    // report-success-on-failure defect this codebase keeps being bitten by —
    // and here it costs a customer. Giving them a direct address turns a silent
    // loss into a recoverable one.
    // `saved` is DERIVED, not asserted.
    //
    // This branch used to hard-code `saved: true` and tell the applicant "We've
    // recorded your application" — while the database write above is still
    // caught and swallowed, leaving applicationId null. So when the write AND
    // the notification both failed, a prospective gym was told their
    // application was safe when nothing had been recorded anywhere. That is
    // report-success-on-failure inside the fix for report-success-on-failure,
    // and it was caught by review rather than by anything in the code.
    const saved = applicationId !== null;
    return NextResponse.json(
      {
        ok: false,
        id: applicationId,
        saved,
        error: saved
          ? "We've recorded your application, but our notification system didn't respond — please email hello@matflow.studio so we don't miss you."
          : "We couldn't record your application and couldn't reach our team either — please email hello@matflow.studio so we don't miss you.",
      },
      { status: 502 },
    );
  }

  // A human was notified, so the lead is safe even if the row is not — but say
  // which, rather than implying both.
  return NextResponse.json({ ok: true, id: applicationId, saved: applicationId !== null });
}
