"use client";

/**
 * The small building blocks the Reports page and its extracted cards share.
 * They lived inside ReportsView.tsx; a card in its own file needs the same
 * title row, empty frame and number format, so they are defined once here.
 */
import type { ElementType } from "react";

export type TooltipPayload = {
  value?: number | string;
  payload?: Record<string, unknown>;
};

export function formatNumber(value: number) {
  return value.toLocaleString("en-GB");
}

export function SectionTitle({
  title,
  subtitle,
  icon: Icon,
  actions,
  fixedSubtitleHeight = false,
}: {
  title: string;
  subtitle?: string;
  icon?: ElementType;
  /** Optional controls rendered on the right, before the icon (a view switch, a filter). */
  actions?: React.ReactNode;
  /** Reserve two lines for a subtitle that changes with a view, so a longer one never reflows what sits below the card. */
  fixedSubtitleHeight?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
      <div className="min-w-0">
        <h2 className="font-semibold text-sm text-tx-1">{title}</h2>
        {subtitle && <p className={`text-xs mt-0.5 text-tx-3 ${fixedSubtitleHeight ? "min-h-[2.4em]" : ""}`}>{subtitle}</p>}
      </div>
      <div className="flex items-center gap-3">
        {actions}
        {Icon && <Icon className="w-4 h-4 mt-0.5 text-tx-3" />}
      </div>
    </div>
  );
}

export function EmptyChart({ label }: { label: string }) {
  return (
    <div className="h-[180px] flex items-center justify-center rounded-xl border border-dashed border-bd-default">
      <p className="text-sm text-tx-3">{label}</p>
    </div>
  );
}
