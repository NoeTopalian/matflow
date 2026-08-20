"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * PageHeader primitive — the one page-title treatment (docs/UI-RULES.md §4).
 * No per-page heading inventions: every staff page opens with this.
 *
 * Renders an `<h1>` (one per page), an optional description and an optional
 * right-aligned action slot, with the `mb-6` gap to the content below. The
 * layout owns the container, so this component declares no width of its own
 * (§4a.1).
 */
export function PageHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned slot — normally a single primary `Button`. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      data-slot="page-header"
      className={cn(
        "mb-6 flex flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold text-tx-1">{title}</h1>
        {description ? (
          <p className="mt-1 text-sm text-tx-2">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

export default PageHeader;
