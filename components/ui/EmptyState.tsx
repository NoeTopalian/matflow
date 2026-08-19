"use client";

import type { ReactNode } from "react";

/**
 * EmptyState — for genuinely empty data only (UI-RULES §7).
 * Never render this for a failed request — that is ErrorState's job.
 * Token-driven: safe on light staff and dark member shells alike.
 */
export function EmptyState({
  title,
  hint,
  icon,
  action,
  className = "",
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-[var(--r-md)] px-6 py-10 text-center ${className}`}
      style={{ color: "var(--tx-3)" }}
    >
      {icon ? <div aria-hidden="true">{icon}</div> : null}
      <p className="text-sm font-medium" style={{ color: "var(--tx-2)" }}>
        {title}
      </p>
      {hint ? <p className="text-[13px]">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export default EmptyState;
