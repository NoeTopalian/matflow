// /admin — operator dashboard. At-a-glance platform health.
//
// Server component: 8 health queries fired in parallel via Promise.all,
// then rendered as a grid of cards. Each red number is clickable into a
// drill-down (tenants, applications, activity).

import Link from "next/link";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const oneWeekAgo = sevenDaysAgo;
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  const [
    activeGyms,
    activeGymsLastWeek,
    trialGyms,
    pendingApps,
    lockedOwners,
    stripeBroken,
    failedPayments7d,
    recentActions,
  ] = await withRlsBypass(async (tx) =>
    Promise.all([
      tx.tenant.count({ where: { subscriptionStatus: "active", deletedAt: null } }),
      tx.tenant.count({
        where: { subscriptionStatus: "active", deletedAt: null, createdAt: { lt: oneWeekAgo } },
      }),
      tx.tenant.findMany({
        where: { subscriptionStatus: "trial", deletedAt: null },
        select: { id: true, createdAt: true },
      }),
      tx.gymApplication.count({ where: { status: { in: ["new", "contacted"] } } }),
      tx.user.findMany({
        where: { role: "owner", lockedUntil: { gt: now } },
        select: { id: true, email: true, name: true, tenantId: true, lockedUntil: true },
        take: 20,
      }),
      tx.tenant.count({
        where: { subscriptionStatus: "active", deletedAt: null, stripeConnected: false },
      }),
      tx.payment.aggregate({
        where: { status: "failed", createdAt: { gte: sevenDaysAgo } },
        _count: true,
        _sum: { amountPence: true },
      }),
      tx.auditLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 10,
        select: {
          id: true,
          action: true,
          tenantId: true,
          createdAt: true,
          metadata: true,
        },
      }),
    ]),
  );

  // Trial breakdown by age
  const trialByAge = { fresh: 0, mid: 0, stalled: 0 };
  for (const t of trialGyms) {
    if (t.createdAt >= sevenDaysAgo) trialByAge.fresh += 1;
    else if (t.createdAt >= thirtyDaysAgo) trialByAge.mid += 1;
    else if (t.createdAt >= ninetyDaysAgo) trialByAge.stalled += 1;
    else trialByAge.stalled += 1;
  }
  const totalTrial = trialGyms.length;

  // Active gyms WoW delta
  const wowDelta = activeGyms - activeGymsLastWeek;
  const wowSign = wowDelta > 0 ? "+" : wowDelta < 0 ? "" : "±";

  // Failed payments
  const failedCount = failedPayments7d._count ?? 0;
  const failedPounds = ((failedPayments7d._sum?.amountPence ?? 0) / 100).toFixed(2);

  // Resolve tenant slugs for recent actions
  const actionTenantIds = Array.from(new Set(recentActions.map((a) => a.tenantId)));
  const actionTenants = actionTenantIds.length
    ? await withRlsBypass((tx) =>
        tx.tenant.findMany({
          where: { id: { in: actionTenantIds } },
          select: { id: true, slug: true, name: true },
        }),
      )
    : [];
  const tenantById = new Map(actionTenants.map((t) => [t.id, t]));

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ marginBottom: 32, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Dashboard</h1>
            <p style={{ opacity: 0.6, margin: "4px 0 0", fontSize: 14 }}>Platform health · refreshed {now.toLocaleTimeString()}</p>
          </div>
          <nav style={{ display: "flex", gap: 16, fontSize: 13 }}>
            <Link href="/admin/tenants" style={navLink}>Customers</Link>
            <Link href="/admin/applications" style={navLink}>Applications</Link>
            <Link href="/admin/activity" style={navLink}>Activity</Link>
          </nav>
        </header>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <Card href="/admin/tenants?status=active" label="Active gyms" value={String(activeGyms)} hint={`${wowSign}${wowDelta} WoW`} />
          <Card
            href="/admin/tenants?status=trial"
            label="Trials"
            value={String(totalTrial)}
            hint={
              totalTrial === 0
                ? "—"
                : `${trialByAge.fresh} fresh · ${trialByAge.mid} 7-30d · ${trialByAge.stalled} stalled`
            }
            tone={trialByAge.stalled > 0 ? "warn" : undefined}
          />
          <Card
            href="/admin/applications"
            label="Pending applications"
            value={String(pendingApps)}
            hint={pendingApps === 0 ? "All clear" : "Need review"}
            tone={pendingApps > 0 ? "warn" : undefined}
          />
          <Card
            href="/admin/tenants"
            label="Locked-out owners"
            value={String(lockedOwners.length)}
            hint={lockedOwners.length === 0 ? "—" : "Click owner to reset"}
            tone={lockedOwners.length > 0 ? "danger" : undefined}
          />
          <Card
            href="/admin/tenants?stripe=broken"
            label="Stripe disconnected"
            value={String(stripeBroken)}
            hint="Active gyms w/o payments"
            tone={stripeBroken > 0 ? "danger" : undefined}
          />
          <Card
            href="/admin/activity?action=payment."
            label="Failed payments (7d)"
            value={String(failedCount)}
            hint={failedCount === 0 ? "—" : `£${failedPounds} at risk`}
            tone={failedCount > 0 ? "danger" : undefined}
          />
          <Card
            label="Trial → active rate"
            value="—"
            hint="Wired in v2"
          />
          <Card
            label="MRR"
            value="—"
            hint="Wired when platform pricing lands"
          />
        </div>

        {/* Locked-out owners list, only if any */}
        {lockedOwners.length > 0 && (
          <section style={{ marginTop: 24 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, opacity: 0.7, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Locked-out owners ({lockedOwners.length})
            </h2>
            <div style={cardWrap}>
              {lockedOwners.map((o) => (
                <div key={o.id} style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13 }}>{o.name}</div>
                    <div style={{ fontSize: 11, opacity: 0.5 }}>{o.email}</div>
                  </div>
                  <Link href={`/admin/tenants/${o.tenantId}`} style={{ fontSize: 12, color: "#818cf8", textDecoration: "none" }}>
                    Reset →
                  </Link>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Recent operator actions */}
        <section style={{ marginTop: 24 }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, opacity: 0.7, margin: 0, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              Recent actions
            </h2>
            <Link href="/admin/activity" style={{ fontSize: 12, color: "#818cf8", textDecoration: "none" }}>
              See all →
            </Link>
          </header>
          <div style={cardWrap}>
            {recentActions.length === 0 ? (
              <div style={{ padding: 24, textAlign: "center", opacity: 0.5, fontSize: 13 }}>No activity yet</div>
            ) : (
              recentActions.map((a) => {
                const t = tenantById.get(a.tenantId);
                const impersonated =
                  a.metadata && typeof a.metadata === "object" && a.metadata !== null && "actingAs" in a.metadata;
                return (
                  <div key={a.id} style={{ padding: "10px 16px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", gap: 12, alignItems: "center" }}>
                    <code style={{ fontSize: 11, padding: "2px 6px", background: "rgba(255,255,255,0.05)", borderRadius: 4, color: "rgba(255,255,255,0.75)" }}>
                      {a.action}
                    </code>
                    <span style={{ fontSize: 12, flex: 1 }}>
                      {t?.name ?? "?"}
                      {impersonated && <span style={{ color: "#f59e0b", marginLeft: 6 }}>(impersonated)</span>}
                    </span>
                    <span style={{ fontSize: 11, opacity: 0.5 }}>{new Date(a.createdAt).toLocaleString()}</span>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Card({
  label,
  value,
  hint,
  href,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  href?: string;
  tone?: "warn" | "danger";
}) {
  const valueColor =
    tone === "danger" ? "#ef4444" : tone === "warn" ? "#f59e0b" : "white";
  const inner = (
    <div
      style={{
        padding: 16,
        background: "#16181d",
        border: "1px solid rgba(255,255,255,0.07)",
        borderRadius: 12,
        textDecoration: "none",
        color: "white",
        cursor: href ? "pointer" : "default",
      }}
    >
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.55, fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, color: valueColor }}>{value}</div>
      {hint && <div style={{ fontSize: 11, opacity: 0.55, marginTop: 4 }}>{hint}</div>}
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: "none" }}>{inner}</Link> : inner;
}

const navLink: React.CSSProperties = { color: "rgba(255,255,255,0.65)", textDecoration: "none" };
const cardWrap: React.CSSProperties = {
  background: "#16181d",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 12,
  overflow: "hidden",
};
