// Shared set-up for the tests that render the real TimetableManager: a class
// builder, the props every render needs, and a fetch stand-in that records
// what the page sent. Each test file still declares its own vi.mock calls
// (they are hoisted per file).

import { vi } from "vitest";
import type { ClassRow } from "@/app/dashboard/timetable/page";

let nextId = 0;
/** A live class. `slots` are [dayOfWeek (0 = Sunday), start, end]. */
export const cls = (name: string, location: string | null, slots: [number, string, string][], over: Partial<ClassRow> = {}): ClassRow => ({
  id: `c${++nextId}`,
  name,
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location,
  locationId: null,
  matId: null,
  duration: 60,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: slots.map(([dayOfWeek, startTime, endTime]) => ({ id: `s${++nextId}`, dayOfWeek, startTime, endTime })),
  roster: [],
  lifecycle: "active",
  archivedAt: null,
  ...over,
});

export const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };

export type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Reply = { ok: boolean; status?: number; json: () => Promise<unknown> };

/**
 * Replaces global fetch. The two reads every render makes are answered; any
 * other request goes to `answer` (default: 200 with an empty object), and
 * every request is recorded in the returned list.
 */
export function stubFetch(answer: (call: Call) => Reply | Promise<Reply> | undefined = () => undefined): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      if (url === "/api/locations") return { ok: true, status: 200, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, status: 200, json: async () => [] };
      const call = { url, method, body };
      calls.push(call);
      return (await answer(call)) ?? { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  return calls;
}
