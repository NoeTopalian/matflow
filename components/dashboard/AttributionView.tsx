"use client";

import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import ConversionFunnel from "@/components/dashboard/ConversionFunnel";
import { formatGuardedRatio } from "@/lib/percent";
import { formatDate } from "@/lib/date";
import type { AttributionData, StaffConversionRow } from "@/lib/attribution";

/**
 * Attribution / conversion dashboard view (M1). Light staff shell, tokens only
 * (UI-RULES §1.5). Renders each coach's trials, sign-ups, conversions and
 * conversion %, with the two honesty guards made visible:
 *   - a rate over fewer than `minTrials` trials shows "N/A" with a "too few"
 *     note rather than a misleading headline percentage;
 *   - the window is labelled "since <epochStart>" so pre-feature members
 *     without attribution don't read as anyone's 0%.
 */
export default function AttributionView({ data }: { data: AttributionData }) {
  const { rows, epochStart, minTrials } = data;

  const windowNote = epochStart
    ? `Counting trials from ${formatDate(epochStart)}. Percentages need at least ${minTrials} trials; fewer shows N/A.`
    : `Percentages need at least ${minTrials} trials; fewer shows N/A.`;

  const columns: DataTableColumn<StaffConversionRow>[] = [
    {
      key: "name",
      header: "Coach",
      headerLabel: "Coach",
      cell: (row) => <span className="font-medium text-tx-1">{row.name}</span>,
      sortValue: (row) => row.name,
    },
    {
      key: "trialsRun",
      header: "Trials run",
      headerLabel: "Trials run",
      align: "right",
      cell: (row) => row.trialsRun,
      sortValue: (row) => row.trialsRun,
    },
    {
      key: "signUps",
      header: "Sign-ups",
      headerLabel: "Sign-ups",
      align: "right",
      cell: (row) => row.signUps,
      sortValue: (row) => row.signUps,
    },
    {
      key: "conversions",
      header: "Converted",
      headerLabel: "Converted",
      align: "right",
      cell: (row) => row.conversions,
      sortValue: (row) => row.conversions,
    },
    {
      key: "conversionRate",
      header: "Conversion %",
      headerLabel: "Conversion %",
      align: "right",
      // The funnel's own text (formatGuardedRatio), so a coach reads one way
      // on this page: "12.5% (5 of 40)"; under the minimum "N/A · too few
      // (1 of 2)"; a coach with sign-ups but no trial "—". Muted without a rate.
      cell: (row) => (
        <span className={row.conversionRate === null ? "tabular-nums text-tx-3" : "tabular-nums text-tx-1"}>
          {formatGuardedRatio(row.conversionRate, row.conversions, row.trialsRun)}
        </span>
      ),
      // Nulls (too few trials) sort to the bottom via the primitive's blank rule.
      sortValue: (row) => row.conversionRate,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Conversion"
        description="How many trials each coach ran, and how many became members."
      />

      {rows.length === 0 ? (
        // The funnel owns the empty state too — one wording on both surfaces.
        <ConversionFunnel data={data} linkRows={false} />
      ) : (
        <div className="space-y-4">
          {/* The same funnel Reports draws — one implementation, so the two
              surfaces can never disagree (components/dashboard/ConversionFunnel). */}
          <ConversionFunnel data={data} linkRows={false} />
          <Card padding="none">
            <DataTable
              label="Per-coach conversion"
              columns={columns}
              rows={rows}
              rowKey={(row) => row.userId}
            />
            <p className="border-t border-bd-default px-3 py-2 text-[13px] text-tx-3">{windowNote}</p>
          </Card>
        </div>
      )}
    </div>
  );
}
