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
      },
    }),
  );
  if (!tenant) notFound();

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
