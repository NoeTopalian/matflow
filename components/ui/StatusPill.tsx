import type { ComponentType, SVGProps } from "react";

/**
 * Coloured pill with optional inline icon — the chip pattern from
 * MembersList rows. Caller supplies the background + text colours
 * so each surface (payment status, attendance, time-at-rank, role,
 * etc.) can pick its own hue. Use lib/color hex() to derive
 * tinted backgrounds from a base colour.
 */
export function StatusPill({
  icon: Icon,
  label,
  bg,
  color,
  weight = "semibold",
}: {
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  label: string;
  bg: string;
  color: string;
  weight?: "semibold" | "bold";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-${weight} px-2.5 py-1 rounded-full whitespace-nowrap`}
      style={{ background: bg, color }}
    >
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </span>
  );
}
