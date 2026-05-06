// /admin/tenants/[id] — super-admin only. Tenant detail + "Login as owner"
// button that mints an impersonation cookie. Gated by proxy.ts admin-cookie.

import Link from "next/link";
import { notFound } from "next/navigation";
import { withRlsBypass } from "@/lib/prisma-tenant";
import LoginAsOwnerButton from "./LoginAsOwnerButton";
import DangerZone from "./DangerZone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id },
      select: {
        id: true, name: true, slug: true, subscriptionStatus: true, subscriptionTier: true,
        currency: true, country: true, createdAt: true, deletedAt: true,
        stripeConnected: true, stripeAccountId: true,
        users: {
          where: { role: "owner" },
          select: { id: true, email: true, name: true, totpEnabled: true, lockedUntil: true },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { members: true, classes: true } },
      },
    }),
  );
  if (!tenant) notFound();

  const owner = tenant.users[0];
  const isSuspended = tenant.subscriptionStatus === "suspended";
  const isDeleted = tenant.deletedAt !== null;

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 900, margin: "0 auto" }}>
        <Link href="/admin/tenants" style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, textDecoration: "none" }}>
          ← Back to tenants
        </Link>

        <header style={{ marginTop: 16, marginBottom: 32 }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: 0 }}>{tenant.name}</h1>
          <p style={{ opacity: 0.6, margin: "6px 0 0", fontSize: 14 }}>
            slug: <code style={{ background: "rgba(255,255,255,0.05)", padding: "1px 6px", borderRadius: 4 }}>{tenant.slug}</code>
            {" · "}created {new Date(tenant.createdAt).toLocaleDateString()}
          </p>
        </header>

        {/* Login-as-owner card */}
        {owner ? (
          <div style={card}>
            <h2 style={cardTitle}>Login as owner</h2>
            <p style={cardDesc}>
              Take over the owner account temporarily to investigate or fix a customer issue.
              Every action you take will be audit-logged with both your admin context and{" "}
              <strong>{owner.name}</strong>&apos;s id.
            </p>
            <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 14 }}><strong>{owner.name}</strong></div>
              <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>{owner.email}</div>
              <div style={{ fontSize: 11, opacity: 0.5, marginTop: 6 }}>
                2FA: {owner.totpEnabled ? "✓ enabled" : "✗ not enrolled"}
                {owner.lockedUntil && new Date(owner.lockedUntil) > new Date() ? " · 🔒 locked" : ""}
              </div>
            </div>
            <LoginAsOwnerButton ownerUserId={owner.id} ownerName={owner.name} />
          </div>
        ) : (
          <div style={card}>
            <h2 style={cardTitle}>No owner</h2>
            <p style={cardDesc}>This tenant has no owner-role user yet.</p>
          </div>
        )}

        {/* Stats */}
        <div style={{ ...card, marginTop: 16 }}>
          <h2 style={cardTitle}>Snapshot</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, fontSize: 13 }}>
            <Stat label="Members" value={String(tenant._count.members)} />
            <Stat label="Classes" value={String(tenant._count.classes)} />
            <Stat label="Status" value={isDeleted ? "deleted" : tenant.subscriptionStatus} />
            <Stat label="Tier" value={tenant.subscriptionTier} />
            <Stat label="Currency" value={tenant.currency} />
            <Stat label="Country" value={tenant.country ?? "—"} />
            <Stat label="Stripe" value={tenant.stripeConnected ? "Connected" : "Not connected"} />
          </div>
        </div>

        {/* Danger Zone */}
        <div style={{ marginTop: 16 }}>
          <DangerZone
            tenantId={tenant.id}
            tenantName={tenant.name}
            ownerName={owner?.name ?? null}
            ownerEmail={owner?.email ?? null}
            isSuspended={isSuspended}
            isDeleted={isDeleted}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.5, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#16181d",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  padding: 24,
};
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: "0 0 8px" };
const cardDesc: React.CSSProperties = { fontSize: 13, opacity: 0.65, margin: "0 0 16px", lineHeight: 1.5 };
