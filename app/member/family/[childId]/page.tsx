import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, Calendar, Award, FileCheck2, AlertTriangle } from "lucide-react";

function ageFrom(d: Date | null) {
  if (!d) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

export default async function ChildProfilePage({ params }: { params: Promise<{ childId: string }> }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) notFound();

  const { childId } = await params;

  // findFirst with full WHERE — never findUnique-by-id-then-check.
  const child = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: {
        id: childId,
        parentMemberId: memberId,
        tenantId: session.user.tenantId,
      },
      include: {
        memberRanks: {
          orderBy: { achievedAt: "desc" },
          take: 1,
          include: { rankSystem: true },
        },
        attendances: {
          orderBy: { checkInTime: "desc" },
          take: 20,
          include: {
            classInstance: { include: { class: { select: { name: true } } } },
          },
        },
        _count: { select: { attendances: true } },
      },
    }),
  );

  if (!child) notFound();

  const age = ageFrom(child.dateOfBirth);
  const currentRank = child.memberRanks[0];

  return (
    <div className="px-4 pt-4 pb-8">
      <Link
        href="/member/profile"
        className="inline-flex items-center gap-1 text-gray-400 text-sm mb-4 hover:text-white transition-colors"
      >
        <ChevronLeft className="w-4 h-4" /> Back to profile
      </Link>

      <h1 className="text-white text-xl font-bold mb-1">{child.name}</h1>
      <p className="text-gray-500 text-sm mb-5">
        {age !== null ? `Age ${age} · ` : ""}{child.accountType === "kids" ? "Kids" : child.accountType}
      </p>

      {/* Belt + waiver status row */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--member-border)" }}>
          <div className="flex items-center gap-2 mb-2">
            <Award className="w-4 h-4 text-gray-500" />
            <span className="text-gray-500 text-xs uppercase tracking-wider">Belt</span>
          </div>
          {currentRank ? (
            <>
              <p className="text-white text-sm font-semibold">{currentRank.rankSystem.name}</p>
              <p className="text-gray-500 text-xs mt-0.5">{currentRank.stripes} stripe{currentRank.stripes !== 1 ? "s" : ""}</p>
            </>
          ) : (
            <p className="text-gray-500 text-sm">Not awarded yet</p>
          )}
        </div>

        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--member-border)" }}>
          <div className="flex items-center gap-2 mb-2">
            <FileCheck2 className="w-4 h-4 text-gray-500" />
            <span className="text-gray-500 text-xs uppercase tracking-wider">Waiver</span>
          </div>
          {child.waiverAccepted ? (
            <p className="text-emerald-400 text-sm font-semibold">Signed</p>
          ) : (
            <p className="text-amber-400 text-sm font-semibold flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> Missing
            </p>
          )}
        </div>
      </div>

      {/* Attendance counter */}
      <div className="rounded-2xl border p-4 mb-5" style={{ borderColor: "var(--member-border)" }}>
        <div className="flex items-center gap-2 mb-1">
          <Calendar className="w-4 h-4 text-gray-500" />
          <span className="text-gray-500 text-xs uppercase tracking-wider">Total classes</span>
        </div>
        <p className="text-white text-2xl font-bold">{child._count.attendances}</p>
      </div>

      {/* Recent attendance */}
      <div className="rounded-2xl border overflow-hidden mb-5" style={{ borderColor: "var(--member-border)" }}>
        <div className="px-4 pt-4 pb-3">
          <p className="text-white text-sm font-semibold">Recent classes</p>
          <p className="text-gray-500 text-xs mt-0.5">Last 20 check-ins</p>
        </div>
        {child.attendances.length === 0 ? (
          <p className="px-4 pb-4 text-gray-500 text-sm">No classes attended yet.</p>
        ) : (
          <ul>
            {child.attendances.map((a, i) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 px-4 py-3"
                style={{ borderTop: i === 0 ? "1px solid var(--member-border)" : "1px solid var(--member-border)" }}
              >
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{a.classInstance.class.name}</p>
                  <p className="text-gray-500 text-xs">
                    {a.classInstance.date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
                <span className="text-gray-600 text-xs shrink-0">
                  {a.checkInTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="text-gray-700 text-[10px] text-center px-4 pb-3">
        Read-only · Belt and rank changes are managed by the gym
      </p>
    </div>
  );
}
