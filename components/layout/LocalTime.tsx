"use client";

import { useSyncExternalStore } from "react";
import { formatTime } from "@/lib/date";

/**
 * A wall-clock time in the VIEWER's own timezone. A server component that
 * formats a time renders it in the server's zone (UTC on Vercel): the support
 * banner said "ends 17:42" at 18:12 UK (owner screenshot, 12 Oct 2026).
 *
 * suppressHydrationWarning alone would not fix it: React keeps the SERVER text
 * when hydration text differs. So the server snapshot is empty and the browser
 * snapshot is the formatted time; useSyncExternalStore re-renders after
 * hydration with the client value (no setState in an effect).
 */
const noSubscription = () => () => {};

export default function LocalTime({ epochMs }: { epochMs: number }) {
  const text = useSyncExternalStore(noSubscription, () => formatTime(epochMs), () => "");
  return <time dateTime={new Date(epochMs).toISOString()}>{text}</time>;
}
