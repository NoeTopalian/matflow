// P1.6 Login Notifications — recordLoginEvent: fire-and-forget hook called
// from the Credentials authorize() / Google signIn() success paths.
//
// Behaviour:
//   1. Compute deviceHash from /24-IP + UA-summary.
//   2. Upsert by (subjectId, deviceHash). Touch lastSeenAt; capture ipApprox/uaSummary
//      on first sight.
//   3. "Is new" iff: no row existed pre-upsert OR existing row has disownedAt set.
//   4. If new AND notifyOnNewLogin not opted out (server-side override for owners):
//      sign a disown token and send the login_new_device email.
//
// All errors are swallowed — login responses must never block on this. Same
// best-effort posture as logAudit.

import { createHmac, timingSafeEqual } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { withTenantContext } from "@/lib/prisma-tenant";
import { deviceHash, normaliseIp, summariseUa } from "@/lib/login-fingerprint";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";

type Subject =
  | { kind: "user"; id: string; email: string; tenantId: string; role: string; notifyOnNewLogin: boolean }
  | { kind: "member"; id: string; email: string; tenantId: string; notifyOnNewLogin: boolean };

type RecordArgs = {
  subject: Subject;
  ip: string | null | undefined;
  ua: string | null | undefined;
  appUrl: string; // base URL — used to build the disown link in the email
  gymName: string;
};

// Feature flag — defaults OFF until explicitly enabled. Server-side reads
// process.env.NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS so it can be flipped in
// Vercel without a redeploy and stays consistent with how P1.5 (Google OAuth)
// gated its rollout.
function loginNotificationsEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS === "true";
}

const DISOWN_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function signDisownToken(loginEventId: string, issuedAt = Date.now()): string {
  const payload = `${loginEventId}.${issuedAt}`;
  const sig = createHmac("sha256", AUTH_SECRET_VALUE).update(payload).digest("hex");
  // base64url-encode "loginEventId.issuedAt.sig" — three parts so the verifier
  // can reject anything that isn't shaped right before doing crypto.
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

export function verifyDisownToken(
  raw: string,
): { ok: true; loginEventId: string } | { ok: false; reason: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const parts = decoded.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [loginEventId, issuedAtStr, providedSig] = parts;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return { ok: false, reason: "malformed" };
  if (Date.now() - issuedAt > DISOWN_TOKEN_TTL_MS) return { ok: false, reason: "expired" };

  const expected = createHmac("sha256", AUTH_SECRET_VALUE)
    .update(`${loginEventId}.${issuedAt}`)
    .digest("hex");
  // timingSafeEqual requires equal-length buffers
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(providedSig, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }
  return { ok: true, loginEventId };
}

export async function recordLoginEvent(args: RecordArgs): Promise<void> {
  if (!loginNotificationsEnabled()) return;

  try {
    const { subject } = args;
    const dh = deviceHash(args.ip, args.ua);
    const ipApprox = normaliseIp(args.ip);
    const uaSummary = summariseUa(args.ua);
    const now = new Date();

    const isOwner = subject.kind === "user" && subject.role === "owner";
    // Owner override: cannot opt out. Otherwise honour subject's preference.
    const shouldNotify = isOwner ? true : subject.notifyOnNewLogin === true;

    // Upsert + decide isNew in one tenant-scoped transaction.
    const { eventId, isNew } = await withTenantContext(subject.tenantId, async (tx) => {
      const existing =
        subject.kind === "user"
          ? await tx.loginEvent.findFirst({ where: { userId: subject.id, deviceHash: dh } })
          : await tx.loginEvent.findFirst({ where: { memberId: subject.id, deviceHash: dh } });

      if (existing) {
        const refreshed = await tx.loginEvent.update({
          where: { id: existing.id },
          data: {
            lastSeenAt: now,
            // Re-arm: a previously-disowned fingerprint reappearing is again
            // a "new device" event from the user's perspective.
            disownedAt: null,
            // Backfill in case earlier rows lacked these (shouldn't happen
            // post-launch, but cheap to keep).
            ipApprox: existing.ipApprox ?? ipApprox,
            uaSummary: existing.uaSummary ?? uaSummary,
          },
        });
        return { eventId: refreshed.id, isNew: existing.disownedAt !== null };
      }

      const created = await tx.loginEvent.create({
        data: {
          tenantId: subject.tenantId,
          userId: subject.kind === "user" ? subject.id : null,
          memberId: subject.kind === "member" ? subject.id : null,
          deviceHash: dh,
          ipApprox,
          uaSummary,
          firstSeenAt: now,
          lastSeenAt: now,
        },
      });
      return { eventId: created.id, isNew: true };
    });

    if (!isNew || !shouldNotify) return;

    const token = signDisownToken(eventId);
    const baseUrl = args.appUrl.replace(/\/$/, "");
    const disownLink = `${baseUrl}/api/auth/disown-login/${token}`;

    await sendEmail({
      tenantId: subject.tenantId,
      templateId: "login_new_device",
      to: subject.email,
      vars: {
        gymName: args.gymName,
        when: now.toUTCString(),
        ipApprox,
        uaSummary,
        disownLink,
      },
    });

    await logAudit({
      tenantId: subject.tenantId,
      userId: subject.kind === "user" ? subject.id : null,
      action: "auth.login.new_device_notified",
      entityType: subject.kind === "user" ? "User" : "Member",
      entityId: subject.id,
      metadata: { ipApprox, uaSummary, loginEventId: eventId },
    });
  } catch {
    // Best-effort — never break the user-facing login on a notification error.
  }
}
