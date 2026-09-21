// POST /api/settings/display — owner-only management of the per-tenant public
// leaderboard URL. Mirrors /api/settings/kiosk exactly, but manages the DISPLAY
// token (Tenant.displayTokenHash), which is deliberately SEPARATE from the
// kiosk token: the leaderboard is meant to be photographed and left on a TV, so
// its URL must never double as a check-in credential.
//
// Body: { action: "enable" | "regenerate" | "disable" }
//
//   enable      mints a fresh raw token (32-char base64url, ~192 bits of
//               entropy), HMAC-hashes it via lib/token-hash, stores the hash
//               on Tenant.displayTokenHash + sets displayTokenIssuedAt. Returns
//               the RAW token in the response — the only time it leaves the
//               server. Calling on an already-enabled tenant returns 409 (use
//               regenerate).
//
//   regenerate  same as enable but works on already-enabled tenants. The old
//               URL 404s on the next request because displayTokenHash now
//               matches a different value.
//
//   disable     clears displayTokenHash + displayTokenIssuedAt. Old URL 404s.

import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["enable", "regenerate", "disable"]),
});

function mintRawToken(): string {
  // 24 bytes → 32 base64url chars. Way more than enough entropy that brute-
  // forcing against a rate-limited endpoint is infeasible.
  return randomBytes(24).toString("base64url");
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  }
  const { action } = parsed.data;

  const tenantId = session.user.tenantId;

  if (action === "disable") {
    await withTenantContext(tenantId, (tx) =>
      tx.tenant.update({
        where: { id: tenantId },
        data: { displayTokenHash: null, displayTokenIssuedAt: null },
      }),
    );
    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "tenant.display.disabled",
      entityType: "Tenant",
      entityId: tenantId,
      req,
    });
    return NextResponse.json({ ok: true, enabled: false });
  }

  // enable / regenerate
  const current = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { displayTokenHash: true },
    }),
  );

  if (action === "enable" && current?.displayTokenHash) {
    return NextResponse.json(
      { error: "Leaderboard already enabled — use regenerate to mint a new URL." },
      { status: 409 },
    );
  }

  const raw = mintRawToken();
  const hash = hashToken(raw);
  const issuedAt = new Date();

  await withTenantContext(tenantId, (tx) =>
    tx.tenant.update({
      where: { id: tenantId },
      data: { displayTokenHash: hash, displayTokenIssuedAt: issuedAt },
    }),
  );

  await logAudit({
    tenantId,
    userId: session.user.id,
    action: action === "regenerate" ? "tenant.display.regenerated" : "tenant.display.enabled",
    entityType: "Tenant",
    entityId: tenantId,
    req,
  });

  return NextResponse.json({
    ok: true,
    enabled: true,
    rawToken: raw,        // shown ONCE — never returned again
    issuedAt: issuedAt.toISOString(),
  });
}

// GET /api/settings/display — owner-only, returns enabled state + issuedAt.
// Never returns the raw token (we don't have it; only the hash is stored).
export async function GET() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { displayTokenHash: true, displayTokenIssuedAt: true },
    }),
  );
  return NextResponse.json({
    enabled: !!tenant?.displayTokenHash,
    issuedAt: tenant?.displayTokenIssuedAt?.toISOString() ?? null,
  });
}
