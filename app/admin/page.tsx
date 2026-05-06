// /admin - operator dashboard. At-a-glance platform health.

import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";
import AdminTopNav from "./AdminTopNav";
import {
  adminCard,
  adminContainer,
  adminPage,
  adminPageSub,
  adminPageTitle,
  adminPalette,
  adminSectionTitle,
  adminSpace,
} from "./admin-theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  // Resolve operator identity for the top-nav chip (best-effort; falls back to null).
  const cookieStore = await cookies();
  const opCookie = cookieStore.get(OP_SESSION_COOKIE)?.value;
  const operator = await resolveOperatorFromCookie(opCookie).catch(() => null);
  const operatorEmail = operator?.email ?? null;

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

  const trialByAge = { fresh: 0, mid: 0, stalled: 0 };
  for (const t of trialGyms) {
    if (t.createdAt >= sevenDaysAgo) trialByAge.fresh += 1;
    else if (t.createdAt >= thirtyDaysAgo) trialByAge.mid += 1;
    else if (t.createdAt >= ninetyDaysAgo) trialByAge.stalled += 1;
    else trialByAge.stalled += 1;
  }

  const totalTrial = trialGyms.length;
  const wowDelta = activeGyms - activeGymsLastWeek;
  const wowSign = wowDelta > 0 ? "+" : wowDelta < 0 ? "" : "+/-";
  const failedCount = failedPayments7d._count ?? 0;
  const failedPounds = ((failedPayments7d._sum?.amountPence ?? 0) / 100).toFixed(2);

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
    <div style={adminPage}>
      <AdminTopNav operatorEmail={operatorEmail} />
      <div style={adminContainer}>
        <header style={{ marginBottom: adminSpace.xl }}>
          <h1 style={adminPageTitle}>Dashboard</h1>
          <p style={adminPageSub}>Platform health — refreshed {now.toLocaleTimeString()}</p>
        </header>

        <div style={grid}>
          <Card href="/admin/tenants?status=active" label="Active gyms" value={String(activeGyms)} hint={`${wowSign}${wowDelta} WoW`} />
          <Card
            href="/admin/tenants?status=trial"
            label="Trials"
            value={String(totalTrial)}
            hint={
              totalTrial === 0
                ? "-"
                : `${trialByAge.fresh} fresh - ${trialByAge.mid} 7-30d - ${trialByAge.stalled} stalled`
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
            hint={lockedOwners.length === 0 ? "-" : "Click owner to reset"}
            tone={lockedOwners.length > 0 ? "danger" : undefined}
          />
          <Card
            href="/admin/tenants?stripe=broken"
            label="Stripe disconnected"
            value={String(stripeBroken)}
            hint="Active gyms without payments"
            tone={stripeBroken > 0 ? "danger" : undefined}
          />
          <Card
            href="/admin/activity?action=payment."
            label="Failed payments (7d)"
            value={String(failedCount)}
            hint={failedCount === 0 ? "-" : `GBP ${failedPounds} at risk`}
            tone={failedCount > 0 ? "danger" : undefined}
          />
          <Card label="Trial to active rate" value="-" hint="Wired in v2" />
          <Card label="MRR" value="-" hint="Wired when platform pricing lands" />
        </div>

        {lockedOwners.length > 0 && (
          <section style={{ marginTop: 24 }}>
            <h2 style={adminSectionTitle}>Locked-out owners ({lockedOwners.length})</h2>
            <div style={list}>
              {lockedOwners.map((o) => (
                <div key={o.id} style={row}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 650 }}>{o.name}</div>
                    <div style={mutedSmall}>{o.email}</div>
                  </div>
                  <Link href={`/admin/tenants/${o.tenantId}`} style={actionLink}>Reset</Link>
                </div>
              ))}
            </div>
          </section>
        )}

        <section style={{ marginTop: 24 }}>
          <header style={sectionHeader}>
            <h2 style={{ ...adminSectionTitle, margin: 0 }}>Recent actions</h2>
            <Link href="/admin/activity" style={actionLink}>See all</Link>
          </header>
          <div style={list}>
            {recentActions.length === 0 ? (
              <div style={empty}>No activity yet</div>
            ) : (
              recentActions.map((a) => {
                const t = tenantById.get(a.tenantId);
                const impersonated =
                  a.metadata && typeof a.metadata === "object" && a.metadata !== null && "actingAs" in a.metadata;
                return (
                  <div key={a.id} style={row}>
                    <code style={code}>{a.action}</code>
                    <span style={{ fontSize: 12, flex: 1 }}>
                      {t?.name ?? "Unknown tenant"}
                      {impersonated && <span style={{ color: adminPalette.amber, marginLeft: 6 }}>(impersonated)</span>}
                    </span>
                    <span style={mutedSmall}>{new Date(a.createdAt).toLocaleString()}</span>
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
    tone === "danger" ? adminPalette.red : tone === "warn" ? adminPalette.amber : adminPalette.text;
  const inner = (
    <div style={{ ...adminCard, padding: 16, cursor: href ? "pointer" : "default" }}>
      <div style={cardLabel}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 750, marginTop: 6, color: valueColor }}>{value}</div>
      {hint && <div style={cardHint}>{hint}</div>}
    </div>
  );
  return href ? <Link href={href} style={{ textDecoration: "none" }}>{inner}</Link> : inner;
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
const grid: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 };
const cardLabel: React.CSSProperties = { fontSize: 11, textTransform: "uppercase", color: adminPalette.muted, fontWeight: 800 };
const cardHint: React.CSSProperties = { fontSize: 11, color: adminPalette.muted, marginTop: 4 };
const list: React.CSSProperties = { ...adminCard, overflow: "hidden" };
const row: React.CSSProperties = {
  padding: "12px 16px",
  borderTop: `1px solid ${adminPalette.borderSoft}`,
  display: "flex",
  gap: 12,
  alignItems: "center",
  justifyContent: "space-between",
};
const mutedSmall: React.CSSProperties = { fontSize: 11, color: adminPalette.muted };
const actionLink: React.CSSProperties = { fontSize: 12, color: adminPalette.blue, textDecoration: "none", fontWeight: 750 };
const sectionHeader: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 };
const code: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 6px",
  background: adminPalette.cardSoft,
  border: `1px solid ${adminPalette.borderSoft}`,
  borderRadius: 4,
  color: adminPalette.text,
};
const empty: React.CSSProperties = { padding: 24, textAlign: "center", color: adminPalette.muted, fontSize: 13 };
