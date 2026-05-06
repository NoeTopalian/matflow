// /admin/billing — cross-tenant financial rollup.
//
// Server-rendered. Aggregates Payment + Dispute + Tenant data via
// withRlsBypass. There is no platform-level pricing model yet, so MRR
// is reported as "gross succeeded payments last 30 days" with a note —
// this is the most useful number we can give until the platform
// pricing tier table lands.

import Link from "next/link";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PENCE_PER_POUND = 100;

function fmtGBP(pence: number): string {
  return `£${(pence / PENCE_PER_POUND).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function AdminBillingPage() {
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

    // Resolve tenant names for the two top-N tables
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
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ marginBottom: 32, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Billing</h1>
            <p style={{ opacity: 0.6, margin: "4px 0 0", fontSize: 14 }}>Cross-tenant payment + dispute rollup</p>
          </div>
          <nav style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <Link href="/admin" style={navLink}>Dashboard</Link>
            <Link href="/admin/tenants" style={navLink}>Customers</Link>
            <Link href="/admin/activity" style={navLink}>Activity</Link>
          </nav>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <Card label="Gross succeeded (30d)" value={fmtGBP(grossPence)} hint={`${grossCount} payment${grossCount === 1 ? "" : "s"}`} />
          <Card
            label="Failed payments (7d)"
            value={String(failedCount)}
            hint={failedCount === 0 ? "—" : `${fmtGBP(failedPence)} at risk`}
            tone={failedCount > 0 ? "danger" : undefined}
          />
          <Card
            label="Open disputes"
            value={String(openCount)}
            hint={openCount === 0 ? "—" : `${fmtGBP(openPence)} contested`}
            tone={openCount > 0 ? "warn" : undefined}
          />
          <Card
            label="Lost disputes (30d)"
            value={String(lostCount)}
            hint={lostCount === 0 ? "—" : `${fmtGBP(lostPence)} written off`}
            tone={lostCount > 0 ? "danger" : undefined}
          />
          <Card
            label="Stripe disconnected"
            value={String(data.stripeBroken)}
            hint="Active gyms w/o payments"
            tone={data.stripeBroken > 0 ? "danger" : undefined}
          />
          <Card label="Platform MRR" value="—" hint="Wired when platform pricing tier table lands" />
        </div>

        <section style={{ marginTop: 24 }}>
          <h2 style={sectionTitle}>Top paying gyms (succeeded, 30d)</h2>
          <div style={cardWrap}>
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
          <h2 style={sectionTitle}>Most payment failures (30d)</h2>
          <div style={cardWrap}>
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
                    secondary={fmtGBP(sumPence) + " total"}
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
  const valueColor = tone === "danger" ? "#ef4444" : tone === "warn" ? "#f59e0b" : "white";
  return (
    <div style={{ padding: 16, background: "#16181d", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.55, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 6, color: valueColor }}>{value}</div>
      {hint && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

function Row({ rank, name, slug, tenantId, primary, secondary, tone }: { rank: number; name: string; slug: string | null; tenantId: string; primary: string; secondary?: string; tone?: "danger" }) {
  return (
    <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ fontSize: 12, opacity: 0.4, width: 22 }}>#{rank}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link href={`/admin/tenants/${tenantId}`} style={{ color: "white", textDecoration: "none", fontSize: 14 }}>
          {name}
        </Link>
        {slug && <span style={{ fontSize: 11, opacity: 0.5, marginLeft: 8 }}>@{slug}</span>}
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: tone === "danger" ? "#ef4444" : "white" }}>{primary}</div>
        {secondary && <div style={{ fontSize: 11, opacity: 0.55 }}>{secondary}</div>}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "32px 24px", textAlign: "center", opacity: 0.5, fontSize: 13 }}>{children}</div>;
}

const navLink: React.CSSProperties = { color: "rgba(255,255,255,0.65)", textDecoration: "none" };
const cardWrap: React.CSSProperties = {
  background: "#16181d",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  overflow: "hidden",
};
const sectionTitle: React.CSSProperties = { fontSize: 14, fontWeight: 600, opacity: 0.7, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" };
