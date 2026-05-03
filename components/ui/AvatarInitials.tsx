"use client";

import { hex } from "@/lib/color";

/**
 * Coloured-circle avatar with up-to-2 initials. Lifted from the
 * MembersList row pattern so other owner-facing list pages get the
 * same look. Tints the background with the supplied colour at 18%
 * alpha; text colour matches the source colour at full opacity.
 */
export function AvatarInitials({
  name,
  color,
  size = "md",
}: {
  name: string;
  color: string;
  size?: "sm" | "md";
}) {
  const initials =
    name
      .split(" ")
      .map((n) => n[0])
      .filter(Boolean)
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?";
  const dims = size === "sm" ? "w-7 h-7 text-[10px]" : "w-9 h-9 text-xs";
  return (
    <div
      className={`${dims} rounded-xl flex items-center justify-center font-bold shrink-0`}
      style={{ background: hex(color, 0.18), color }}
    >
      {initials}
    </div>
  );
}
