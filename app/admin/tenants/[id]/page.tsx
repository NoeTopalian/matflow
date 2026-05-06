// /admin/tenants/[id] - tenant detail and operator actions.

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { adminCard, adminContainer, adminNavLink, adminPage, adminPalette } from "../../admin-theme";
import LoginAsOwnerButton from "./LoginAsOwnerButton";
import DangerZone from "./DangerZone";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminTenantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  const { id } = await params;

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        subscriptionStatus: true,
        subscriptionTier: true,
        currency: true,
        country: true,
        createdAt: true,
        deletedAt: true,
        stripeConnected: true,
        stripeAccountId: true,
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
    <div style={adminPage}>
      <div style={{ ...adminContainer, maxWidth: 900 }}>
        <Link href="/admin/tenants" style={{ ...adminNavLink, fontSize: 13 }}>Back to tenants</Link>

        <header style={{ marginTop: 16, marginBottom: 32 }}>
          <h1 style={{ fontSize: 32, fontWeight: 750, margin: 0 }}>{tenant.name}</h1>
          <p style={{ color: adminPalette.muted, margin: "6px 0 0", fontSize: 14 }}>
            slug: <code style={inlineCode}>{tenant.slug}</code>
            {" - "}created {new Date(tenant.createdAt).toLocaleDateString()}
          </p>
        </header>

        {owner ? (
          <div style={card}>
            <h2 style={cardTitle}>Login as owner</h2>
            <p style={cardDesc}>
              Take over the owner account temporarily to investigate or fix a customer issue.
              Every action is audit-logged with both your operator context and{" "}
              <strong>{owner.name}</strong>&apos;s id.
            </p>
            <div style={ownerBox}>
              <div style={{ fontSize: 14 }}><strong>{owner.name}</strong></div>
              <div style={{ fontSize: 12, color: adminPalette.muted, marginTop: 2 }}>{owner.email}</div>
              <div style={{ fontSize: 11, color: adminPalette.muted, marginTop: 6 }}>
                2FA: {owner.totpEnabled ? "enabled" : "not enrolled"}
                {owner.lockedUntil && new Date(owner.lockedUntil) > new Date() ? " - locked" : ""}
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

        <div style={{ ...card, marginTop: 16 }}>
          <h2 style={cardTitle}>Snapshot</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, fontSize: 13 }}>
            <Stat label="Members" value={String(tenant._count.members)} />
            <Stat label="Classes" value={String(tenant._count.classes)} />
            <Stat label="Status" value={isDeleted ? "deleted" : tenant.subscriptionStatus} />
            <Stat label="Tier" value={tenant.subscriptionTier} />
            <Stat label="Currency" value={tenant.currency} />
            <Stat label="Country" value={tenant.country ?? "-"} />
            <Stat label="Stripe" value={tenant.stripeConnected ? "Connected" : "Not connected"} />
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <DangerZone
            tenantId={tenant.id}
            tenantName={tenant.name}
            ownerName={owner?.name ?? null}
            ownerEmail={owner?.email ?? null}
            ownerTotpEnabled={owner?.totpEnabled ?? false}
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
      <div style={{ fontSize: 11, textTransform: "uppercase", color: adminPalette.muted, fontWeight: 750 }}>{label}</div>
      <div style={{ marginTop: 2 }}>{value}</div>
    </div>
  );
}

const card: React.CSSProperties = { ...adminCard, padding: 24 };
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 700, margin: "0 0 8px" };
const cardDesc: React.CSSProperties = { fontSize: 13, color: adminPalette.muted, margin: "0 0 16px", lineHeight: 1.5 };
const inlineCode: React.CSSProperties = { background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, padding: "1px 6px", borderRadius: 4 };
const ownerBox: React.CSSProperties = { background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, padding: 12, marginBottom: 16 };
