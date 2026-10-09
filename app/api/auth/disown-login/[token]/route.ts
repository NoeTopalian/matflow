// P1.6 Login Notifications — disown endpoint ("Wasn't me?" link from email).
//
// Public-by-design: the legitimate user might be locked out of the JWT path
// by the attacker, so we can't require an authenticated session here. Token
// is HMAC-signed (AUTH_SECRET) with a 7-day TTL — see lib/login-event.ts.
//
// GET NO LONGER CHANGES ANYTHING (SF-37 / SEC-045, security campaign
// iteration 2, lane A2, 9 Oct 2026). The emailed link used to perform the
// whole disown on GET: bump the session version and lock the account for an
// hour. Mail security scanners (Microsoft Safe Links, Mimecast, Proofpoint,
// Gmail's own link checks) fetch links in incoming mail before the person
// does — so the "new sign-in" email itself signed the person out everywhere
// and locked their account, without anyone clicking. GET now renders a
// confirmation page; the change happens only on the POST that page's button
// sends. The token in the path is still the only credential (a cross-site
// POST needs the token, which is the credential itself).
//
// On POST with a valid token:
//   1. Bump the subject's sessionVersion (kicks every existing JWT — same
//      mechanism as logout-all).
//   2. Set lockedUntil = now + 1h so the original password no longer works
//      until the user goes through the forgot-password flow.
//   3. Mark the LoginEvent.disownedAt — replay protection (a second click is
//      a no-op) and ensures the *next* sign-in from that fingerprint will
//      again be considered "new" and re-notify.
//   4. Audit log auth.login.disowned.
//
// Rate-limited to 10/h per IP to slow enumeration of LoginEvent IDs.

import { NextResponse } from "next/server";
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { verifyDisownToken } from "@/lib/login-event";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

const ACCOUNT_LOCK_AFTER_DISOWN_MS = 60 * 60 * 1000; // 1 hour

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  // The token is in the URL: never send it to another site. Not "no-referrer":
  // that makes the browser send `Origin: null` on the form's POST, which the
  // same-origin check below would refuse.
  "referrer-policy": "same-origin",
  "x-robots-tag": "noindex",
};

function page(title: string, body: string, status = 200): Response {
  const html =
    '<!doctype html><html lang="en-GB"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title>` +
    "<style>body{margin:0;font-family:system-ui,sans-serif;background:#f7f7f8;color:#1a1a1a;display:grid;place-items:center;min-height:100vh;padding:16px}" +
    "main{max-width:30rem}button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #b42318;background:#b42318;color:#fff;cursor:pointer}" +
    "a{color:inherit}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style>" +
    `</head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

/** GET: show what the button will do. Changes nothing, whoever (or whatever) fetches it. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const verified = token ? verifyDisownToken(token) : { ok: false as const };
  if (!verified.ok) {
    return page(
      "Link not valid",
      "<h1>This link is no longer valid</h1><p>It may have expired. If you think someone else has signed in to your account, reset your password from the sign-in page.</p><p><a href=\"/login\">Go to sign in</a></p>",
      400,
    );
  }
  const action = new URL(req.url).pathname;
  return page(
    "Wasn't you?",
    "<h1>Wasn't you?</h1>" +
      "<p>If you didn't sign in just now, confirm below. We will sign this account out on every device and lock password sign-in for an hour, so you can reset your password.</p>" +
      `<form method="post" action="${action.replace(/"/g, "&quot;")}"><button type="submit">Sign out everywhere and lock my account</button></form>` +
      "<p>If it was you, close this page. Nothing has changed.</p>",
  );
}

/** POST: the confirmed disown. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  // The confirmation page posts from this origin; a cross-site POST is refused
  // before anything (SEC-042 convention for every mutating route).
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`disown:ip:${ip}`, 10, 60 * 60 * 1000);
  const baseUrl = new URL(req.url).origin;
  // 303: the browser follows a POST's redirect with a GET.
  const fail = () => NextResponse.redirect(`${baseUrl}/login?disowned=invalid`, 303);
  const ok = () => NextResponse.redirect(`${baseUrl}/login?disowned=1`, 303);

  if (!rl.allowed) return fail();

  const { token } = await params;
  if (!token) return fail();

  const verified = verifyDisownToken(token);
  if (!verified.ok) return fail();

  // Find the LoginEvent. We don't have a session yet, so go through bypass to
  // resolve tenant + subject, then switch to tenant-scoped writes.
  const event = await withRlsBypass((tx) =>
    tx.loginEvent.findUnique({ where: { id: verified.loginEventId } }),
  );
  if (!event) return fail();

  // Replay protection: an already-disowned event's link is a no-op success.
  // We deliberately do NOT differentiate this from "good link, first click"
  // in the response — both redirect the same way to avoid leaking state.
  if (event.disownedAt) return ok();

  try {
    const claimed = await withTenantContext(event.tenantId, async (tx) => {
      // Claim the event first (conditional), so two concurrent confirmations
      // disown once: one bump, one lock, one audit row.
      const claim = await tx.loginEvent.updateMany({
        where: { id: event.id, disownedAt: null },
        data: { disownedAt: new Date() },
      });
      if (claim.count !== 1) return false;
      const lockedUntil = new Date(Date.now() + ACCOUNT_LOCK_AFTER_DISOWN_MS);
      if (event.userId) {
        await tx.user.update({
          where: { id: event.userId },
          data: {
            sessionVersion: { increment: 1 },
            lockedUntil,
          },
        });
      } else if (event.memberId) {
        await tx.member.update({
          where: { id: event.memberId },
          data: {
            sessionVersion: { increment: 1 },
            lockedUntil,
          },
        });
      }
      return true;
    });
    if (!claimed) return ok();

    await logAudit({
      tenantId: event.tenantId,
      userId: event.userId ?? null,
      action: "auth.login.disowned",
      entityType: event.userId ? "User" : "Member",
      entityId: event.userId ?? event.memberId ?? event.id,
      metadata: { loginEventId: event.id, ipApprox: event.ipApprox, uaSummary: event.uaSummary },
      req,
    });
  } catch {
    return fail();
  }

  return ok();
}
