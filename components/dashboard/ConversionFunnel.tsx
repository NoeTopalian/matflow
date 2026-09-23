"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowDownRight, Users } from "lucide-react";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatDate } from "@/lib/date";
import type { AttributionData, FunnelSteps, StaffConversionRow } from "@/lib/attribution";

/**
 * The conversion funnel — ONE implementation, drawn on Reports (under the stat
 * tiles) and on /dashboard/attribution (above its table), so the two never
 * disagree.
 *
 * What it draws: the club-wide funnel — Trials run → Converted → Still active —
 * with the drop-off between each step spelled out (lost before joining, still
 * deciding, churned after joining), then the same three steps per coach with a
 * mini bar chart and the honest rates.
 *
 * Honesty (UI-RULES §7), all of it visible on the surface:
 *   - rates under the min-N threshold render "N/A · too few", never a number;
 *   - the window is labelled "since <epoch>" so pre-feature members don't read
 *     as anyone's 0%;
 *   - no trials at all → EmptyState, never a row of zero bars.
 *
 * Tokens only (UI-RULES §2): the tenant accent via `--color-primary`, the same
 * `--hue-success` / `--hue-warning` inks the TrendBadge uses. Bars are plain
 * divs with a runtime width — no chart library, nothing to configure, and the
 * percentages are real text for screen readers and the CSV.
 */
export default function ConversionFunnel({
  data,
  /** Wrap coach rows in a link to the attribution page (true on Reports; false there). */
  linkRows = true,
}: {
  data: AttributionData;
  linkRows?: boolean;
}) {
  const { rows, overall, epochStart, minTrials } = data;

  const windowNote = epochStart
    ? `Since attribution began on ${formatDate(epochStart)}. Rates need at least ${minTrials} trials — fewer shows N/A.`
    : `Rates need at least ${minTrials} trials — fewer shows N/A.`;

  if (rows.length === 0) {
    return (
      <Card>
        <FunnelTitle />
        <EmptyState
          icon={<Users className="w-6 h-6" aria-hidden="true" />}
          title="No trials recorded yet"
          hint="Create a member as a taster with a coach attached — their journey shows up here as soon as it starts."
        />
      </Card>
    );
  }

  return (
    <Card>
      <FunnelTitle />

      <OverallFunnel steps={overall} />

      <div className="mt-6 border-t pt-4" style={{ borderColor: "var(--bd-default)" }}>
        <h3 className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: "var(--tx-3)" }}>
          By coach
        </h3>
        <ul className="divide-y" style={{ borderColor: "var(--bd-default)" }} aria-label="Conversion funnel by coach">
          {rows.map((row) => (
            <li key={row.userId}>
              <CoachRow row={row} linkRows={linkRows} />
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-4 text-[11px]" style={{ color: "var(--tx-3)" }}>{windowNote}</p>
    </Card>
  );
}

function FunnelTitle() {
  return (
    <div className="flex items-start justify-between gap-3 mb-4">
      <div>
        <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>Conversion funnel</h2>
        <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
          Every trial with a coach attached — where it went, and who ran it. Club-wide; the filters above don&rsquo;t change it.
        </p>
      </div>
    </div>
  );
}

function rateText(rate: number | null, suffix: string): string {
  return rate === null ? "N/A · too few" : `${rate.toFixed(1)}% ${suffix}`;
}

function pctOf(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * Three steps as horizontal bars, each width relative to trials (the widest),
 * and the drop-off between steps written out beneath the bar it leaves.
 */
function OverallFunnel({ steps }: { steps: FunnelSteps }) {
  const max = Math.max(steps.trials, 1);
  const width = (n: number) => `${Math.max((n / max) * 100, n > 0 ? 2 : 0)}%`;

  return (
    <div className="space-y-1.5">
      <FunnelBar
        label="Trials run"
        count={steps.trials}
        width={width(steps.trials)}
        tone="primary"
        note={null}
      />
      <DropOff>
        <DropItem tone="warning" text={`−${steps.lost} lost before joining · ${pctOf(steps.lost, steps.trials)}`} />
        <DropItem tone="neutral" text={`${steps.undecided} still deciding · ${pctOf(steps.undecided, steps.trials)}`} />
      </DropOff>
      <FunnelBar
        label="Converted"
        count={steps.converted}
        width={width(steps.converted)}
        tone="primary"
        note={rateText(steps.conversionRate, "of trials")}
      />
      <DropOff>
        <DropItem tone="warning" text={`−${steps.churned} churned after joining · ${pctOf(steps.churned, steps.converted)}`} />
      </DropOff>
      <FunnelBar
        label="Still active"
        count={steps.retained}
        width={width(steps.retained)}
        tone="success"
        note={rateText(steps.retentionRate, "of converted")}
      />
    </div>
  );
}

const TONE_FILL: Record<"primary" | "success", string> = {
  primary: "var(--color-primary)",
  success: "var(--hue-success)",
};

function FunnelBar({
  label,
  count,
  width,
  tone,
  note,
}: {
  label: string;
  count: number;
  width: string;
  tone: "primary" | "success";
  note: string | null;
}) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] sm:grid-cols-[120px_minmax(0,1fr)_150px] items-center gap-3">
      <span className="text-xs font-medium truncate" style={{ color: "var(--tx-2)" }}>{label}</span>
      <div
        className="h-8 rounded-[var(--r-sm)] overflow-hidden"
        style={{ background: "color-mix(in srgb, var(--tx-1) 5%, transparent)" }}
        role="img"
        aria-label={`${label}: ${count.toLocaleString("en-GB")}`}
      >
        <div
          className="h-full rounded-[var(--r-sm)] flex items-center pl-2.5 transition-[width] duration-300 motion-reduce:transition-none"
          style={{ width, background: TONE_FILL[tone] }}
        >
          <span className="text-xs font-bold tabular-nums" style={{ color: "var(--tx-on-accent)" }}>
            {count.toLocaleString("en-GB")}
          </span>
        </div>
      </div>
      <span
        className="hidden sm:block text-[11px] tabular-nums truncate"
        style={{ color: note?.startsWith("N/A") ? "var(--tx-3)" : "var(--tx-2)" }}
        title={note ?? undefined}
      >
        {note ?? ""}
      </span>
    </div>
  );
}

function DropOff({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[96px_minmax(0,1fr)] sm:grid-cols-[120px_minmax(0,1fr)_150px] gap-3">
      <span aria-hidden="true" />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 pl-1">{children}</div>
    </div>
  );
}

function DropItem({ tone, text }: { tone: "warning" | "neutral"; text: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] tabular-nums"
      style={{ color: tone === "warning" ? "var(--hue-warning-ink)" : "var(--tx-3)" }}
    >
      <ArrowDownRight className="w-3 h-3 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * One coach: a mini three-bar funnel in a fixed track, then the numbers. The
 * track is a fixed width so a coach with 40 trials and one with 3 line up.
 */
function CoachRow({ row, linkRows }: { row: StaffConversionRow; linkRows: boolean }) {
  const max = Math.max(row.trialsRun, 1);
  const w = (n: number) => `${Math.max((n / max) * 100, n > 0 ? 3 : 0)}%`;

  const body = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <span className="w-40 shrink-0 text-sm font-medium truncate" style={{ color: "var(--tx-1)" }} title={row.name}>
        {row.name}
      </span>

      <div className="w-40 shrink-0 space-y-1" role="img" aria-label={`${row.name}: ${row.trialsRun} trials, ${row.conversions} converted, ${row.retained} still active`}>
        <MiniBar width={w(row.trialsRun)} fill="var(--color-primary)" opacity={0.35} />
        <MiniBar width={w(row.conversions)} fill="var(--color-primary)" opacity={0.75} />
        <MiniBar width={w(row.retained)} fill="var(--hue-success)" opacity={1} />
      </div>

      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs tabular-nums min-w-0">
        <Stat term="Trials" value={String(row.trialsRun)} />
        <Stat
          term="Converted"
          value={row.conversionRate === null ? `${row.conversions} · N/A` : `${row.conversions} · ${row.conversionRate.toFixed(0)}%`}
          muted={row.conversionRate === null}
        />
        <Stat
          term="Still active"
          value={row.retentionRate === null ? `${row.retained} · N/A` : `${row.retained} · ${row.retentionRate.toFixed(0)}%`}
          muted={row.retentionRate === null}
        />
        <Stat term="Lost" value={String(row.lost)} muted={row.lost === 0} />
        <Stat term="Deciding" value={String(row.undecided)} muted={row.undecided === 0} />
      </dl>
    </div>
  );

  if (!linkRows) return body;
  return (
    <Link
      href="/dashboard/attribution"
      className="block rounded-[var(--r-sm)] -mx-2 px-2 transition-colors hover:bg-[color-mix(in_srgb,var(--tx-1)_4%,transparent)]"
      aria-label={`${row.name} — open the conversion table`}
    >
      {body}
    </Link>
  );
}

function MiniBar({ width, fill, opacity }: { width: string; fill: string; opacity: number }) {
  return (
    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "color-mix(in srgb, var(--tx-1) 5%, transparent)" }}>
      <div className="h-full rounded-full" style={{ width, background: fill, opacity }} />
    </div>
  );
}

function Stat({ term, value, muted = false }: { term: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt style={{ color: "var(--tx-3)" }}>{term}</dt>
      <dd className="font-semibold" style={{ color: muted ? "var(--tx-3)" : "var(--tx-1)" }}>{value}</dd>
    </div>
  );
}
