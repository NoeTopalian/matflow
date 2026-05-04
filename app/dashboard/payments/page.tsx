/**
 * /dashboard/payments — owner payments inbox.
 *
 * Consolidates the "members who need chasing" view in one place. Lists
 * every Member with paymentStatus='overdue' or 'pending', plus the most
 * recent failed Payment row per member (when one exists). Each row has
 * quick links to existing actions:
 *
 *   - View profile (where the Mark Paid Manually + audit log already live)
 *   - mailto: link with a prefilled "your payment didn't go through" body
 *     so the owner can chase without leaving the dashboard
 *
 * Future v2 (queued in plan file): bulk reminder send, one-click retry
 * via Stripe API, cancel/pause subscription, AR aging buckets.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { AlertTriangle, CreditCard, Mail, ArrowRight, ExternalLink, RotateCcw } from "lucide-react";
import { AvatarInitials } from "@/components/ui/AvatarInitials";
import { StatusPill } from "@/components/ui/StatusPill";

type OverdueRow = {
  id: string;
  name: string;
  email: string;
  membershipType: string | null;
  paymentStatus: string;
  lastFailedAt: Date | null;
  lastFailureReason: string | null;
  totalOutstandingPence: number;
};

export default async function PaymentsInboxPage() {
  const { session } = await requireRole(["owner"]);
  if (!session) redirect("/login");
  const tenantId = session.user.tenantId;
  const primaryColor = session.user.primaryColor ?? "#3b82f6";

  // Members in overdue/pending payment state (the canonical "needs chasing" set).
  const overdue = await withTenantContext(tenantId, (tx) =>
    tx.member.findMany({
      where: {
        tenantId,
        paymentStatus: { in: ["overdue", "pending"] },
        status: { not: "cancelled" },
      },
      select: {
        id: true,
        name: true,
        email: true,
        membershipType: true,
        paymentStatus: true,
        payments: {
          where: { status: "failed" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, failureReason: true, amountPence: true },
        },
      },
      orderBy: { name: "asc" },
      take: 200,
    }),
  );

  const rows: OverdueRow[] = overdue.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    membershipType: m.membershipType,
    paymentStatus: m.paymentStatus,
    lastFailedAt: m.payments[0]?.createdAt ?? null,
    lastFailureReason: m.payments[0]?.failureReason ?? null,
    totalOutstandingPence: m.payments[0]?.amountPence ?? 0,
  }));

  // Tenant total $$ at risk so the owner sees the urgency at a glance.
  const totalOutstandingPence = rows.reduce((sum, r) => sum + r.totalOutstandingPence, 0);

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="flex items-start gap-4">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(239,68,68,0.12)", color: "#ef4444" }}
        >
          <AlertTriangle className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Payments inbox
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            {rows.length === 0
              ? "Nobody is currently overdue. ✅"
              : `${rows.length} member${rows.length === 1 ? "" : "s"} need${rows.length === 1 ? "s" : ""} chasing` +
                (totalOutstandingPence > 0
                  ? ` · £${(totalOutstandingPence / 100).toFixed(2)} outstanding from last failed charges`
                  : "")}
          </p>
        </div>
        <Link
          href="/dashboard/settings?tab=revenue"
          className="hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
        >
          Revenue summary <ExternalLink className="w-3 h-3" />
        </Link>
      </header>

      {rows.length === 0 ? (
        <div
          className="rounded-2xl border p-12 text-center"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          <CreditCard className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--tx-4)" }} />
          <p className="text-base font-semibold mb-1" style={{ color: "var(--tx-1)" }}>
            All payments up to date
          </p>
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>
            New failed-payment alerts and overdue members appear here automatically.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const daysOverdue = row.lastFailedAt
              ? Math.floor((Date.now() - row.lastFailedAt.getTime()) / (1000 * 60 * 60 * 24))
              : null;
            const mailtoBody = encodeURIComponent(
              `Hi ${row.name.split(" ")[0]},\n\n` +
                `We tried to take your last membership payment but it didn't go through.\n` +
                (row.lastFailureReason
                  ? `The bank's reason: "${row.lastFailureReason}".\n\n`
                  : "\n") +
                `Could you check your card details (it may have expired) and try again? Just reply to this email if you'd like to switch to a different payment method.\n\n` +
                `Thanks,\n${session.user.tenantName ?? "Your gym"}`,
            );
            const mailtoSubject = encodeURIComponent(
              `${session.user.tenantName ?? "Your gym"}: payment didn't go through`,
            );
            const mailto = `mailto:${row.email}?subject=${mailtoSubject}&body=${mailtoBody}`;

            return (
              <Link
                key={row.id}
                href={`/dashboard/members/${row.id}`}
                className="flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-colors group"
                style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
              >
                <AvatarInitials name={row.name} color={primaryColor} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                    {row.name}
                  </p>
                  <p className="text-xs truncate" style={{ color: "var(--tx-4)" }}>
                    {row.membershipType ?? "No membership"}
                    {daysOverdue !== null && ` · last failed ${daysOverdue}d ago`}
                    {row.lastFailureReason && ` · "${row.lastFailureReason}"`}
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-2 shrink-0">
                  {row.totalOutstandingPence > 0 && (
                    <StatusPill
                      icon={CreditCard}
                      label={`£${(row.totalOutstandingPence / 100).toFixed(2)}`}
                      bg="rgba(239,68,68,0.12)"
                      color="#ef4444"
                    />
                  )}
                  <StatusPill
                    icon={RotateCcw}
                    label={row.paymentStatus}
                    bg={row.paymentStatus === "overdue" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)"}
                    color={row.paymentStatus === "overdue" ? "#ef4444" : "#f59e0b"}
                  />
                  <a
                    href={mailto}
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors hover:bg-white/5"
                    style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                    title="Compose chase email"
                  >
                    <Mail className="w-3 h-3" /> Email
                  </a>
                </div>
                <ArrowRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
              </Link>
            );
          })}
        </div>
      )}

      <div className="rounded-2xl border p-4 text-xs" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
        <p className="font-semibold mb-1" style={{ color: "var(--tx-2)" }}>What happens here</p>
        <p>Members appear when Stripe reports their last invoice failed (Member.paymentStatus auto-flips to <code>overdue</code>) or when their card is being retried (<code>pending</code>). Open a member to mark a payment paid manually, refund a charge, or see their full history. Stripe Smart Retries are on for connected accounts — most failed cards recover automatically over 3-7 days; this inbox is for the ones that don't.</p>
      </div>
    </div>
  );
}
