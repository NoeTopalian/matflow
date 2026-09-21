// /leaderboard/[token] — public, TV-displayed attendance leaderboard.
//
// The [token] segment is the raw DISPLAY token — NOT the kiosk token. They are
// separate on purpose: a leaderboard is meant to be photographed and left on a
// wall-mounted TV, so its URL must not double as a check-in credential. The
// server hashes the raw token and looks up the matching Tenant by
// `displayTokenHash`. No match (or a short token) renders a generic 404 — it
// never reveals whether the token was malformed or simply unknown.
//
// Like the kiosk, this page lives OUTSIDE the dashboard / member layouts: no
// NextAuth session, no admin cookies, no sidebar. The URL is the only key, and
// a paused club shows a paused screen rather than its branding or a 404.

import { notFound } from "next/navigation";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { tenantAdmission, admissionMessage } from "@/lib/tenant-admission";
import { getLeaderboard } from "@/lib/leaderboard";
import LeaderboardPage from "@/components/leaderboard/LeaderboardPage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!token || token.length < 16) notFound();

  const tokenHash = hashToken(token);
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findFirst({
      where: { displayTokenHash: tokenHash },
      select: {
        id: true,
        name: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        logoUrl: true,
        fontFamily: true,
        timezone: true,
        subscriptionStatus: true,
        deletedAt: true,
      },
    }),
  );
  if (!tenant) notFound();

  // A paused club's TV shows a paused screen, not its branding and not a 404 —
  // the URL is valid, the club is simply not open for business. Identical
  // discipline to the kiosk (app/kiosk/[token]/page.tsx).
  const admission = tenantAdmission(tenant);
  if (!admission.admits) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sf-bg px-6">
        <div className="max-w-md rounded-[var(--r-lg)] border border-bd-1 bg-sf-1 p-8 text-center">
          <h1 className="text-xl font-semibold text-tx-1">Leaderboard paused</h1>
          <p className="mt-3 text-sm text-tx-3">{admissionMessage(admission.reason, "member")}</p>
        </div>
      </main>
    );
  }

  const board = await getLeaderboard(tenant.id, tenant.timezone);

  return (
    <LeaderboardPage
      tenant={{
        name: tenant.name,
        primaryColor: tenant.primaryColor,
        bgColor: tenant.bgColor,
        textColor: tenant.textColor,
        logoUrl: tenant.logoUrl,
        fontFamily: tenant.fontFamily,
      }}
      board={board}
    />
  );
}
