// /admin/billing - cross-tenant financial rollup.

import Link from "next/link";
import { redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { adminCard, adminContainer, adminNavLink, adminPage, adminPalette, adminSectionTitle } from "../admin-theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENCE_PER_POUND = 100;

function fmtGBP(pence: number): string {
  return `GBP ${(pence / PENCE_PER_POUND).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function AdminBillingPage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const data = await withRlsBypass(async (tx) => {
    const [
      grossLast30,
      failedLast7,
      failedLast30ByTenant,
      openDisputes,
      lostDisputes30,
      stripeBroken,
      paidLast30ByTenant,
    ] = await Promise.all([
      tx.payment.aggregate({
        where: { status: "succeeded", paidAt: { gte: thirtyDaysAgo } },
        _count: true,
        _sum: { amountPence: true },
      }),
      tx.payment.aggregate({
        where: { status: "failed", createdAt: { gte: sevenDaysAgo } },
        _count: true,
        _sum: { amountPence: true },
      }),
      tx.payment.groupBy({
        by: ["tenantId"],
        where: { status: "failed", createdAt: { gte: thirtyDaysAgo } },
        _count: { _all: true },
        _sum: { amountPence: true },
        orderBy: { _count: { tenantId: "desc" } },
        take: 5,
      }),
      tx.dispute.aggregate({
        where: { status: { in: ["needs_response", "under_review"] } },
        _count: true,
        _sum: { amountPence: true },
      }),
      tx.dispute.aggregate({
        where: { status: "lost", updatedAt: { gte: thirtyDaysAgo } },
        _count: true,
        _sum: { amountPence: true },
      }),
      tx.tenant.count({ where: { subscriptionStatus: "active", deletedAt: null, stripeConnected: false } }),
      tx.payment.groupBy({
        by: ["tenantId"],
        where: { status: "succeeded", paidAt: { gte: thirtyDaysAgo } },
        _sum: { amountPence: true },
        _count: { _all: true },
        orderBy: { _sum: { amountPence: "desc" } },
        take: 10,
      }),
    ]);

    const tenantIds = Array.from(
      new Set([
        ...failedLast30ByTenant.map((r) => r.tenantId),
        ...paidLast30ByTenant.map((r) => r.tenantId),
      ]),
    );
    const tenants = tenantIds.length
      ? await tx.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true, slug: true },
        })
      : [];

    return {
      grossLast30,
      failedLast7,
      failedLast30ByTenant,
      openDisputes,
      lostDisputes30,
      stripeBroken,
      paidLast30ByTenant,
      tenantMap: new Map(tenants.map((t) => [t.id, t])),
    };
  });

  const grossPence = data.grossLast30._sum?.amountPence ?? 0;
  const grossCount = data.grossLast30._count ?? 0;
  const failedPence = data.failedLast7._sum?.amountPence ?? 0;
  const failedCount = data.failedLast7._count ?? 0;
  const openCount = data.openDisputes._count ?? 0;
  const openPence = data.openDisputes._sum?.amountPence ?? 0;
  const lostCount = data.lostDisputes30._count ?? 0;
  const lostPence = data.lostDisputes30._sum?.amountPence ?? 0;

  return (
    <div style={adminPage}>
      <div style={adminContainer}>
        <header style={header}>
          <div>
            <h1 style={title}>Billing</h1>
            <p style={subtitle}>Cross-tenant payment and dispute rollup</p>
          </div>
          <nav style={nav}>
            <Link href="/admin" style={adminNavLink}>Dashboard</Link>
            <Link href="/admin/tenants" style={adminNavLink}>Customers</Link>
            <Link href="/admin/activity" style={adminNavLink}>Activity</Link>
            <Link href="/admin/security" style={adminNavLink}>Security</Link>
          </nav>
        </header>

        <div style={grid}>
          <Card label="Gross succeeded (30d)" value={fmtGBP(grossPence)} hint={`${grossCount} payment${grossCount === 1 ? "" : "s"}`} />
          <Card
            label="Failed payments (7d)"
            value={String(failedCount)}
            hint={failedCount === 0 ? "-" : `${fmtGBP(failedPence)} at risk`}
            tone={failedCount > 0 ? "danger" : undefined}
          />
          <Card
            label="Open disputes"
            value={String(openCount)}
            hint={openCount === 0 ? "-" : `${fmtGBP(openPence)} contested`}
            tone={openCount > 0 ? "warn" : undefined}
          />
          <Card
            label="Lost disputes (30d)"
            value={String(lostCount)}
            hint={lostCount === 0 ? "-" : `${fmtGBP(lostPence)} written off`}
            tone={lostCount > 0 ? "danger" : undefined}
          />
          <Card
            label="Stripe disconnected"
            value={String(data.stripeBroken)}
            hint="Active gyms without payments"
            tone={data.stripeBroken > 0 ? "danger" : undefined}
          />
          <Card label="Platform MRR" value="-" hint="Wired when platform pricing tier table lands" />
        </div>

        <section style={{ marginTop: 24 }}>
          <h2 style={adminSectionTitle}>Top paying gyms (succeeded, 30d)</h2>
          <div style={list}>
            {data.paidLast30ByTenant.length === 0 ? (
              <Empty>No succeeded payments in the last 30 days.</Empty>
            ) : (
              data.paidLast30ByTenant.map((row, i) => {
                const t = data.tenantMap.get(row.tenantId);
                const sumPence = row._sum?.amountPence ?? 0;
                const count = row._count?._all ?? 0;
                return (
                  <Row
                    key={row.tenantId}
                    rank={i + 1}
                    name={t?.name ?? "(unknown tenant)"}
                    slug={t?.slug ?? null}
                    tenantId={row.tenantId}
                    primary={fmtGBP(sumPence)}
                    secondary={`${count} payment${count === 1 ? "" : "s"}`}
                  />
                );
              })
            )}
          </div>
        </section>

        <section style={{ marginTop: 24 }}>
          <h2 style={adminSectionTitle}>Most payment failures (30d)</h2>
          <div style={list}>
            {data.failedLast30ByTenant.length === 0 ? (
              <Empty>No payment failures in the last 30 days.</Empty>
            ) : (
              data.failedLast30ByTenant.map((row, i) => {
                const t = data.tenantMap.get(row.tenantId);
                const sumPence = row._sum?.amountPence ?? 0;
                const count = row._count?._all ?? 0;
                return (
                  <Row
                    key={row.tenantId}
                    rank={i + 1}
                    name={t?.name ?? "(unknown tenant)"}
                    slug={t?.slug ?? null}
                    tenantId={row.tenantId}
                    primary={`${count} failed`}
                    secondary={`${fmtGBP(sumPence)} total`}
                    tone="danger"
                  />
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Card({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "warn" | "danger" }) {
  const valueColor = tone === "danger" ? adminPalette.red : tone === "warn" ? adminPalette.amber : adminPalette.text;
  return (
    <div style={{ ...adminCard, padding: 16 }}>
      <div style={cardLabel}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 750, marginTop: 6, color: valueColor }}>{value}</div>
      {hint && <div style={cardHint}>{hint}</div>}
    </div>
  );
}

function Row({ rank, name, slug, tenantId, primary, secondary, tone }: { rank: number; name: string; slug: string | null; tenantId: string; primary: string; secondary?: string; tone?: "danger" }) {
  return (
    <div style={rowStyle}>
      <div style={{ fontSize: 12, color: adminPalette.faint, width: 28 }}>#{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link href={`/admin/tenants/${tenantId}`} style={{ color: adminPalette.text, textDecoration: "none", fontSize: 14, fontWeight: 700 }}>
          {name}
        </Link>
        {slug && <span style={{ fontSize: 11, color: adminPalette.muted, marginLeft: 8 }}>@{slug}</span>}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 14, fontWeight: 750, color: tone === "danger" ? adminPalette.red : adminPalette.text }}>{primary}</div>
        {secondary && <div style={cardHint}>{secondary}</div>}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "32px 24px", textAlign: "center", color: adminPalette.muted, fontSize: 13 }}>{children}</div>;
}

const header: React.CSSProperties = {
  marginBottom: 32,
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 18,
  flexWrap: "wrap",
};
const title: React.CSSProperties = { fontSize: 28, fontWeight: 750, margin: 0 };
const subtitle: React.CSSProperties = { color: adminPalette.muted, margin: "4px 0 0", fontSize: 14 };
const nav: React.CSSProperties = { display: "flex", gap: 16, fontSize: 13, flexWrap: "wrap" };
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 };
const cardLabel: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", color: adminPalette.muted, fontWeight: 800 };
const cardHint: React.CSSProperties = { fontSize: 11, color: adminPalette.muted, marginTop: 4 };
const list: React.CSSProperties = { ...adminCard, overflow: "hidden" };
const rowStyle: React.CSSProperties = {
  borderTop: `1px solid ${adminPalette.borderSoft}`,
  padding: "12px 16px",
  display: "flex",
  alignItems: "center",
  gap: 12,
};
