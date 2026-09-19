// /kiosk/[token] — public iPad kiosk page.
//
// The [token] segment is the raw kiosk token. The server hashes it and looks
// up the matching Tenant. If no match, render a generic 404 — never reveal
// whether the token was malformed vs not-found.
//
// This page intentionally lives OUTSIDE the dashboard / member layouts so it
// gets no NextAuth session, no cookies that point at staff routes, and no
// access to the admin sidebar. The kiosk URL is the only credential.

import { notFound } from "next/navigation";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import KioskPage from "@/components/kiosk/KioskPage";
import { tenantAdmission, admissionMessage } from "@/lib/tenant-admission";

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
      where: { kioskTokenHash: tokenHash },
      select: {
        id: true,
        name: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        logoUrl: true,
        fontFamily: true,
        subscriptionStatus: true,
        deletedAt: true,
      },
    }),
  );
  if (!tenant) notFound();

  // A paused club's tablet shows a paused screen, not its own branding and not
  // a 404. `lib/tenant-admission.ts` is the one place that decides which doors
  // open; the kiosk asked nothing until now, so a suspended club's front desk
  // went on taking attendance indefinitely. A 404 would be the wrong answer
  // here — the URL is valid, the club is simply not open for business — and
  // the member-facing sentence deliberately says nothing about why.
  const admission = tenantAdmission(tenant);
  if (!admission.admits) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-sf-bg px-6">
        <div className="max-w-md rounded-[var(--r-lg)] border border-bd-1 bg-sf-1 p-8 text-center">
          <h1 className="text-xl font-semibold text-tx-1">Check-in is paused</h1>
          <p className="mt-3 text-sm text-tx-3">{admissionMessage(admission.reason, "member")}</p>
        </div>
      </main>
    );
  }

  return (
    <KioskPage
      token={token}
      tenant={{
        name: tenant.name,
        primaryColor: tenant.primaryColor,
        bgColor: tenant.bgColor,
        textColor: tenant.textColor,
        logoUrl: tenant.logoUrl,
        fontFamily: tenant.fontFamily,
      }}
    />
  );
}
