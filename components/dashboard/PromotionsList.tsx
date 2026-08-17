"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Award, ChevronRight } from "lucide-react";

import { hex } from "@/lib/color";
import { AvatarInitials } from "@/components/ui/AvatarInitials";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageHeader } from "@/components/ui/page-header";
import { StatusPill } from "@/components/ui/StatusPill";
import type { PromotionCandidate } from "@/lib/promotion-candidates";

/**
 * The /dashboard/promotions list, split out of the server page the way
 * MembersList is split out of the members page: the page stays a server
 * component that does the tenant-scoped query, this owns the interactive
 * table (DataTable is a client primitive).
 *
 * Desktop gets the §1.5.4 dense table — five columns with the two progress
 * bars living inside their cells — and the primitive collapses to the
 * original candidate cards below `sm:` (§9). Row click goes to the member
 * profile, which is where the promotion is actually applied.
 */

export function progressPct(done: number, target: number): number {
  // A zero/negative threshold means "nothing left to do", not a divide by zero.
  if (target <= 0) return 100;
  return Math.min(100, Math.round((done / target) * 100));
}

function isReady(c: PromotionCandidate): boolean {
  return (
    c.attendancesSinceRank >= c.threshold.minAttendances &&
    c.monthsAtRank >= c.threshold.minMonths
  );
}

function rankLabel(c: PromotionCandidate): string {
  const stripes =
    c.currentStripes > 0
      ? ` · ${c.currentStripes} stripe${c.currentStripes > 1 ? "s" : ""}`
      : "";
  return `${c.rankSystemName} · ${c.discipline}${stripes}`;
}

/**
 * A bar plus its numbers. §8: never colour-only — the "12 / 50" label carries
 * the same information for anyone who cannot see the fill.
 */
function ProgressCell({
  value,
  label,
  complete,
  color,
}: {
  value: number;
  label: string;
  complete: boolean;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-sf-2"
        aria-hidden="true"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${value}%`, background: hex(color, complete ? 1 : 0.55) }}
        />
      </div>
      <span className="whitespace-nowrap tabular-nums text-[11px] text-tx-3">
        {label}
      </span>
    </div>
  );
}

function buildColumns(primaryColor: string): DataTableColumn<PromotionCandidate>[] {
  return [
    {
      key: "member",
      header: "Member",
      sortValue: (c) => c.memberName,
      cell: (c) => (
        <div className="flex items-center gap-3">
          <AvatarInitials name={c.memberName} color={primaryColor} size="sm" />
          <span className="truncate font-semibold text-tx-1">{c.memberName}</span>
        </div>
      ),
    },
    {
      key: "rank",
      header: "Rank",
      sortValue: (c) => c.rankSystemName,
      cell: (c) => (
        <StatusPill
          label={
            <>
              {c.rankSystemName}
              {Array.from({ length: c.currentStripes }).map((_, i) => (
                <span
                  key={i}
                  className="size-1.5 rounded-full bg-current opacity-70"
                />
              ))}
            </>
          }
          bg={hex(primaryColor, 0.12)}
          color={primaryColor}
        />
      ),
    },
    {
      key: "attendance",
      header: "Sessions",
      width: "9rem",
      sortValue: (c) => progressPct(c.attendancesSinceRank, c.threshold.minAttendances),
      cell: (c) => (
        <ProgressCell
          value={progressPct(c.attendancesSinceRank, c.threshold.minAttendances)}
          label={`${c.attendancesSinceRank} / ${c.threshold.minAttendances}`}
          complete={c.attendancesSinceRank >= c.threshold.minAttendances}
          color={primaryColor}
        />
      ),
    },
    {
      key: "time",
      header: "Time at rank",
      width: "9rem",
      sortValue: (c) => progressPct(c.monthsAtRank, c.threshold.minMonths),
      cell: (c) => (
        <ProgressCell
          value={progressPct(c.monthsAtRank, c.threshold.minMonths)}
          label={`${c.monthsAtRank} / ${c.threshold.minMonths} mo`}
          complete={c.monthsAtRank >= c.threshold.minMonths}
          color={primaryColor}
        />
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      sortValue: (c) => (isReady(c) ? 0 : 1),
      cell: (c) =>
        isReady(c) ? (
          <StatusPill
            label="Ready"
            bg={hex(primaryColor, 0.12)}
            color={primaryColor}
          />
        ) : (
          <span className="text-[11px] text-tx-4">In progress</span>
        ),
    },
    {
      key: "go",
      header: "",
      headerLabel: "",
      align: "right",
      width: "3rem",
      cell: () => (
        <ChevronRight className="inline size-4 text-tx-4" aria-hidden="true" />
      ),
    },
  ];
}

export default function PromotionsList({
  candidates,
  primaryColor,
}: {
  candidates: PromotionCandidate[];
  primaryColor: string;
}) {
  const router = useRouter();
  const columns = useMemo(() => buildColumns(primaryColor), [primaryColor]);
  const readyCount = candidates.filter(isReady).length;

  return (
    <div className="w-full">
      <PageHeader
        title="Ready for promotion"
        description="Members who have met the attendance and time-at-rank thresholds for their current belt."
        action={
          readyCount > 0 ? (
            <StatusPill
              icon={Award}
              label={`${readyCount} ${readyCount === 1 ? "member" : "members"} ready`}
              bg={hex(primaryColor, 0.12)}
              color={primaryColor}
            />
          ) : undefined
        }
      />

      {candidates.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Award className="size-7 text-tx-3" />}
            title="No promotions due"
            hint="Members will appear once they hit the attendance and time thresholds."
            action={
              <Link
                href="/dashboard/ranks"
                className="text-xs font-medium underline-offset-2 hover:underline"
                style={{ color: primaryColor }}
              >
                Settings → Ranks
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <p className="mb-4 text-sm text-tx-2">
            {readyCount} of {candidates.length}{" "}
            {candidates.length === 1 ? "member" : "members"} ready · select a
            member to promote them.
          </p>

          {/* The card chrome starts at `sm:` — below that the primitive
              renders its own per-row Cards and an outer card would nest
              white on white. */}
          <div className="sm:overflow-hidden sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
            <DataTable
              label="Promotion candidates"
              rows={candidates}
              rowKey={(c) => `${c.memberId}-${c.rankSystemId}`}
              columns={columns}
              onRowClick={(c) => router.push(`/dashboard/members/${c.memberId}`)}
              renderCard={(c) => {
                const ready = isReady(c);
                return (
                  <Card
                    padding="tight"
                    className="space-y-3 border-l-4"
                    style={{
                      borderLeftColor: ready ? primaryColor : "var(--bd-default)",
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <AvatarInitials name={c.memberName} color={primaryColor} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-tx-1">
                          {c.memberName}
                        </p>
                        <p className="truncate text-xs text-tx-4">{rankLabel(c)}</p>
                      </div>
                      {ready ? (
                        <StatusPill
                          label="Ready"
                          bg={hex(primaryColor, 0.12)}
                          color={primaryColor}
                        />
                      ) : (
                        <ChevronRight
                          className="size-4 shrink-0 text-tx-4"
                          aria-hidden="true"
                        />
                      )}
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] text-tx-4">Sessions</span>
                        <ProgressCell
                          value={progressPct(
                            c.attendancesSinceRank,
                            c.threshold.minAttendances,
                          )}
                          label={`${c.attendancesSinceRank} / ${c.threshold.minAttendances}`}
                          complete={
                            c.attendancesSinceRank >= c.threshold.minAttendances
                          }
                          color={primaryColor}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-[11px] text-tx-4">Time</span>
                        <ProgressCell
                          value={progressPct(c.monthsAtRank, c.threshold.minMonths)}
                          label={`${c.monthsAtRank} / ${c.threshold.minMonths} mo`}
                          complete={c.monthsAtRank >= c.threshold.minMonths}
                          color={primaryColor}
                        />
                      </div>
                    </div>
                  </Card>
                );
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}
