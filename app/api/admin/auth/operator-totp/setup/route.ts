/**
 * GET/POST /api/admin/auth/operator-totp/setup
 *
 * Operator authenticator enrolment (mandatory since 6 Oct 2026).
 *
 * Who may call it:
 *   - an operator holding an ENROLMENT cookie (`matflow_op_enrol`) — password
 *     verified at /api/admin/auth/operator-login, no authenticator yet. This is
 *     the ONLY route that accepts that cookie.
 *   - an operator holding a full (MFA-verified) session — GET only reports
 *     `alreadyEnabled: true`; there is nothing to enrol.
 * The shared MATFLOW_ADMIN_SECRET is never enough here.
 *
 * Enrolment ticket (review finding D3, 6 Oct 2026): the enrolment cookie is
 * not enough either. GET (header `x-matflow-enrolment-ticket`) and POST (body
 * `ticket`) also need the single-use ticket printed by
 * scripts/operator-access.mjs create/recover — 30 minutes, consumed by the
 * conditional update that enables TOTP. Without it the password alone could
 * enrol an attacker's authenticator.
 *
 * GET  creates or returns the pending secret and its QR code.
 * POST verifies a 6-digit code against the pending secret, spends it, enables
 *      TOTP, bumps sessionVersion (every older token of this operator dies),
 *      clears the enrolment cookie and issues the FULL session.
 *
 * CSRF: POST checks the origin like every other operator mutation (audit 5 Oct
 * 2026, Q1/Q6: this route had no check).
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { generateSecret, generateURI } from "otplib";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { withRlsBypass } from "@/lib/prisma-tenant";
import {
  OP_ENROL_COOKIE,
  OP_ENROLMENT_TICKET_HEADER,
  OP_SESSION_COOKIE,
  completeOperatorLogin,
  consumeOperatorTotp,
  hashOperatorEnrolmentTicket,
  issueOperatorSession,
  operatorCookieSetHeaderValue,
  operatorEnrolmentCookieClearHeaderValue,
  resolveOperatorEnrolment,
  resolveOperatorFromCookie,
} from "@/lib/operator-auth";

export const runtime = "nodejs";

const schema = z.object({
  code: z.string().regex(/^\d{6}$/),
  ticket: z.string().max(100).optional(),
});

const TICKET_REFUSED =
  "Enter the enrolment ticket from the operator-access script. A ticket lasts 30 minutes and works once; run the script again for a new one.";

async function resolveCaller(ticket: unknown) {
  const store = await cookies();
  const enrolCookie = store.get(OP_ENROL_COOKIE)?.value;
  const enrolling = await resolveOperatorEnrolment(enrolCookie, { ticket });
  if (enrolling) return { kind: "enrolment" as const, operator: enrolling };
  const full = await resolveOperatorFromCookie(store.get(OP_SESSION_COOKIE)?.value);
  if (full) return { kind: "session" as const, operator: full };
  // A valid enrolment cookie with a missing, wrong, expired or spent ticket:
  // say what is missing rather than a bare 401.
  if (await resolveOperatorEnrolment(enrolCookie, "sign-out-only")) return { kind: "ticket-refused" as const };
  return null;
}

export async function GET(req: Request) {
  const caller = await resolveCaller(req.headers.get(OP_ENROLMENT_TICKET_HEADER));
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (caller.kind === "ticket-refused") {
    return NextResponse.json({ error: TICKET_REFUSED, ticketRequired: true }, { status: 403 });
  }
  if (caller.kind === "session") {
    // A full session exists only for an enrolled operator.
    return NextResponse.json({ alreadyEnabled: true });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: caller.operator.id },
    select: { id: true, email: true, totpEnabled: true, totpSecret: true },
  });
  if (!operator) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (operator.totpEnabled) return NextResponse.json({ alreadyEnabled: true });

  const secret = operator.totpSecret ?? generateSecret();
  if (!operator.totpSecret) {
    await prisma.operator.update({
      where: { id: operator.id },
      data: { totpSecret: secret, totpEnabled: false, totpLastUsedStep: null },
    });
  }

  const uri = generateURI({ label: operator.email, issuer: "MatFlow Admin", secret });
  const qrDataUrl = await QRCode.toDataURL(uri);
  return NextResponse.json(
    { alreadyEnabled: false, secret, qrDataUrl },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);

  const caller = await resolveCaller(parsed.success ? parsed.data.ticket : undefined);
  if (!caller) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (caller.kind === "session") {
    return NextResponse.json({ error: "Two-factor authentication is already enabled." }, { status: 409 });
  }
  if (caller.kind === "ticket-refused") {
    return NextResponse.json({ error: TICKET_REFUSED, ticketRequired: true }, { status: 403 });
  }

  const rl = await checkRateLimit(`admin:operator-totp-setup:${caller.operator.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }
  const ticketHash = hashOperatorEnrolmentTicket(parsed.data.ticket);
  if (!ticketHash) {
    return NextResponse.json({ error: TICKET_REFUSED, ticketRequired: true }, { status: 403 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: caller.operator.id },
    select: { id: true, totpSecret: true, totpEnabled: true, totpLastUsedStep: true },
  });
  if (!operator?.totpSecret) {
    return NextResponse.json({ error: "TOTP not initialised" }, { status: 400 });
  }
  if (operator.totpEnabled) {
    return NextResponse.json({ error: "Two-factor authentication is already enabled." }, { status: 409 });
  }

  const accepted = await consumeOperatorTotp(
    { id: operator.id, totpSecret: operator.totpSecret, totpLastUsedStep: operator.totpLastUsedStep },
    parsed.data.code,
  );
  if (!accepted) {
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  // ONE transaction, before any session exists (review findings D3 + D5):
  //  - conditional on still being unenrolled AND on the ticket still being the
  //    outstanding, unexpired one — two tabs racing cannot both mint a session,
  //    and the ticket is spent by the same write (single use);
  //  - the admin.operator.totp_enrolled row is written in the same transaction
  //    (it used to be best-effort and AFTER the session was minted). If it
  //    cannot be written, nothing changes and no session is issued.
  let enabled: boolean;
  try {
    enabled = await withRlsBypass(async (tx) => {
      const res = await tx.operator.updateMany({
        where: {
          id: operator.id,
          totpEnabled: false,
          enrolmentTicketHash: ticketHash,
          enrolmentTicketExpiresAt: { gt: new Date() },
        },
        data: {
          totpEnabled: true,
          sessionVersion: { increment: 1 },
          enrolmentTicketHash: null,
          enrolmentTicketExpiresAt: null,
        },
      });
      if (res.count !== 1) return false;
      // Platform event (tenantId null): attributable to the named operator.
      await logAudit({
        tx,
        tenantId: null,
        action: "admin.operator.totp_enrolled",
        entityType: "Operator",
        entityId: operator.id,
        actAsUserId: operator.id,
        metadata: { enrolmentTicket: "consumed" },
        req,
      });
      return true;
    });
  } catch (err) {
    console.error("[operator-totp/setup] enrolment or its audit row failed; nothing changed", err);
    return NextResponse.json(
      { error: "Set-up could not be recorded, so nothing was changed. Try again with a new code." },
      { status: 500 },
    );
  }
  if (!enabled) {
    return NextResponse.json({ error: TICKET_REFUSED, ticketRequired: true }, { status: 403 });
  }

  const completed = await completeOperatorLogin(operator.id);

  const sessionToken = issueOperatorSession(completed.id, completed.sessionVersion);
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", operatorCookieSetHeaderValue(sessionToken));
  res.headers.append("Set-Cookie", operatorEnrolmentCookieClearHeaderValue());
  return res;
}
