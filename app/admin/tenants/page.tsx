// /admin/tenants — super-admin only. Lists every Tenant in the platform.
// Gated by proxy.ts admin-cookie check. Sibling to /admin/applications.

import Link from "next/link";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TenantRow = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  ownerName: string | null;
  ownerUserId: string | null;
  memberCount: number;
  status: string;
  createdAt: string;
};

async function getTenants(): Promise<TenantRow[]> {
  const tenants = await withRlsBypass((tx) =>
    tx.tenant.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        subscriptionStatus: true,
        createdAt: true,
        users: {
          where: { role: "owner" },
          take: 1,
          select: { id: true, email: true, name: true },
          orderBy: { createdAt: "asc" },
        },
        _count: { select: { members: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  );
  return tenants.map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    ownerEmail: t.users[0]?.email ?? null,
    ownerName: t.users[0]?.name ?? null,
    ownerUserId: t.users[0]?.id ?? null,
    memberCount: t._count.members,
    status: t.subscriptionStatus,
    createdAt: t.createdAt.toISOString(),
  }));
}

export default async function AdminTenantsPage() {
  const tenants = await getTenants();
  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Tenants</h1>
            <p style={{ opacity: 0.6, margin: "4px 0 0", fontSize: 14 }}>{tenants.length} active gym{tenants.length === 1 ? "" : "s"}</p>
          </div>
          <nav style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <Link href="/admin/applications" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>Applications →</Link>
            <Link href="/admin/login" style={{ color: "rgba(255,255,255,0.4)", textDecoration: "none" }}>Sign out</Link>
          </nav>
        </header>

        <div style={{ background: "#16181d", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead style={{ background: "rgba(255,255,255,0.03)" }}>
              <tr>
                <th style={th}>Gym</th>
                <th style={th}>Owner</th>
                <th style={th}>Members</th>
                <th style={th}>Status</th>
                <th style={th}>Created</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 12, opacity: 0.5 }}>{t.slug}</div>
                  </td>
                  <td style={td}>
                    {t.ownerName ? (
                      <>
                        <div>{t.ownerName}</div>
                        <div style={{ fontSize: 12, opacity: 0.5 }}>{t.ownerEmail}</div>
                      </>
                    ) : (
                      <span style={{ opacity: 0.4 }}>(no owner)</span>
                    )}
                  </td>
                  <td style={td}>{t.memberCount}</td>
                  <td style={td}>
                    <span style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      background: t.status === "active" ? "rgba(16,185,129,0.12)" : "rgba(255,255,255,0.06)",
                      color: t.status === "active" ? "#10b981" : "rgba(255,255,255,0.5)",
                      fontSize: 11,
                      fontWeight: 600,
                    }}>{t.status}</span>
                  </td>
                  <td style={td}>{new Date(t.createdAt).toLocaleDateString()}</td>
                  <td style={td}>
                    <Link
                      href={`/admin/tenants/${t.id}`}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        background: "rgba(255,255,255,0.06)",
                        color: "white",
                        textDecoration: "none",
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                    >View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "12px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.5, fontWeight: 600 };
const td: React.CSSProperties = { padding: "14px 16px", verticalAlign: "top" };
