import { redirect } from "next/navigation";
import Link from "next/link";
import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import DsarActions from "@/components/dashboard/DsarActions";

export default async function MemberDsarPage({ params }: { params: Promise<{ id: string }> }) {
  const { session } = await requireRole(["owner"]);
  const { id } = await params;
  const tenantId = session!.user.tenantId;

  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({
      where: { id, tenantId },
      select: { id: true, name: true, email: true, status: true, joinedAt: true },
    }),
  );

  if (!member) {
    redirect("/dashboard/members");
  }

  const erased = member.status === "cancelled" && member.email.startsWith("deleted-");

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <header>
        <p className="text-[11px] font-bold uppercase tracking-wider mb-1" style={{ color: "rgba(245,158,11,0.85)" }}>
          GDPR Subject Rights
        </p>
        <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>
          Data export &amp; right to erasure
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
          For <strong>{member.name}</strong> (<a href={`mailto:${member.email}`} style={{ color: "var(--color-primary)" }}>{member.email}</a>)
          {member.joinedAt && <> · joined {new Date(member.joinedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</>}
        </p>
      </header>

      {erased && (
        <div className="rounded-2xl border p-4" style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.25)", color: "#fca5a5" }}>
          <p className="text-sm font-semibold">This member has already been erased.</p>
          <p className="text-xs mt-1 opacity-80">PII fields are scrubbed and the row is soft-deleted. Aggregate stats (attendance counts, financial totals) are preserved.</p>
        </div>
      )}

      <section className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--tx-1)" }}>
          1. Export this member&apos;s data (Subject Access Request)
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--tx-3)" }}>
          Generates a single JSON file with every PII row MatFlow holds for this member: profile, attendance history, payments, waivers, ranks, emails sent. Send this to the member as your SAR response.
        </p>
        <DsarActions memberId={id} action="export" disabled={false} />
      </section>

      <section className="rounded-2xl border p-5" style={{ background: erased ? "var(--sf-1)" : "rgba(239,68,68,0.04)", borderColor: erased ? "var(--bd-default)" : "rgba(239,68,68,0.2)" }}>
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--tx-1)" }}>
          2. Erase this member (Right to be forgotten)
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--tx-3)" }}>
          Irreversibly scrubs name, email, phone, date of birth, address, emergency contact, medical conditions, profile photo, and password. Soft-deletes the row. Aggregate stats stay (attendance counts so historical figures aren&apos;t corrupted, payment rows for tax/dispute records). The audit log entry stays as evidence you fulfilled the request.
        </p>
        <p className="text-xs mb-4" style={{ color: "rgba(239,68,68,0.85)" }}>
          ⚠ This cannot be undone. Export the data first if you haven&apos;t already.
        </p>
        <DsarActions memberId={id} action="erase" disabled={erased} />
      </section>

      <Link href={`/dashboard/members/${id}`} className="inline-block text-sm" style={{ color: "var(--tx-3)" }}>
        ← Back to member profile
      </Link>
    </div>
  );
}
