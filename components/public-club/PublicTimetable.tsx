"use client";

/**
 * T9c public club page: the live weekly timetable with a search box and
 * filters (class name, day, coach, and Kids/Adults when the club runs both).
 *
 * Filtering is client-side over the sessions the server already chose to
 * publish (lib/public-club-page.ts) — nothing here fetches. Filter options
 * come from the data, never a fixed list, and a filter that would offer one
 * choice is not shown.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  DAY_NAMES,
  EMPTY_FILTER,
  filterOptions,
  filterSessions,
  type PublicSession,
  type SessionFilter,
} from "@/lib/public-club-page";

function timeRange(s: PublicSession): string {
  return s.endTime ? `${s.startTime}–${s.endTime}` : s.startTime;
}

export default function PublicTimetable({
  sessions,
  ink,
  accent,
  line,
  panel,
}: {
  sessions: PublicSession[];
  ink: string;
  accent: string;
  line: string;
  panel: string;
}) {
  const [filter, setFilter] = useState<SessionFilter>(EMPTY_FILTER);
  const options = useMemo(() => filterOptions(sessions), [sessions]);
  const shown = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);
  const filtered = filter.query.trim() !== "" || filter.day !== null || filter.coach !== null || filter.category !== null;

  const byDay = useMemo(() => {
    const groups: { day: number; rows: PublicSession[] }[] = [];
    for (const s of shown) {
      const last = groups.at(-1);
      if (last && last.day === s.dayOfWeek) last.rows.push(s);
      else groups.push({ day: s.dayOfWeek, rows: [s] });
    }
    return groups;
  }, [shown]);

  return (
    <div className="mt-4" data-testid="public-timetable">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <label className="relative block min-w-0 flex-1 sm:min-w-[220px]">
          <span className="sr-only">Search classes</span>
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" style={{ opacity: 0.5 }} />
          <input
            type="search"
            aria-label="Search classes"
            value={filter.query}
            onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            placeholder="Search classes, coaches or venues"
            className="h-9 w-full rounded-[var(--r-md)] border bg-transparent pl-9 pr-3 text-sm"
            style={{ borderColor: line, color: ink }}
          />
        </label>
        {options.days.length > 1 && (
          <Select
            aria-label="Filter by day"
            className="w-full sm:w-[150px]"
            value={filter.day === null ? "" : String(filter.day)}
            onChange={(e) => setFilter((f) => ({ ...f, day: e.target.value === "" ? null : Number(e.target.value) }))}
          >
            <option value="">Every day</option>
            {options.days.map((d) => (
              <option key={d} value={d}>{DAY_NAMES[d]}</option>
            ))}
          </Select>
        )}
        {options.coaches.length > 1 && (
          <Select
            aria-label="Filter by coach"
            className="w-full sm:w-[170px]"
            value={filter.coach ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, coach: e.target.value || null }))}
          >
            <option value="">Every coach</option>
            {options.coaches.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </Select>
        )}
        {options.showCategory && (
          <Select
            aria-label="Filter by category"
            className="w-full sm:w-[150px]"
            value={filter.category ?? ""}
            onChange={(e) => setFilter((f) => ({ ...f, category: (e.target.value || null) as SessionFilter["category"] }))}
          >
            <option value="">Adults and kids</option>
            <option value="adults">Adults</option>
            <option value="kids">Kids</option>
          </Select>
        )}
        {filtered && (
          <Button variant="ghost" size="compact" onClick={() => setFilter(EMPTY_FILTER)}>
            Clear
          </Button>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="mt-6 text-sm" role="status" style={{ opacity: 0.7 }}>
          No classes match those filters.
        </p>
      ) : (
        <div className="mt-5 space-y-6">
          {byDay.map(({ day, rows }) => (
            <div key={day}>
              <h3 className="text-xs font-semibold uppercase tracking-wider" style={{ color: accent }}>
                {DAY_NAMES[day]}
              </h3>
              <ul className="mt-2 divide-y rounded-2xl border" style={{ borderColor: line, background: panel }}>
                {rows.map((s) => (
                  <li
                    key={s.key}
                    className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                    style={{ borderColor: line }}
                    data-testid="public-session"
                  >
                    <span className="w-[110px] shrink-0 text-sm font-semibold tabular-nums">{timeRange(s)}</span>
                    <span className="min-w-0 flex-1 text-sm font-medium">
                      {s.className}
                      {s.isKids && (
                        <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide" style={{ color: accent }}>
                          Kids
                        </span>
                      )}
                    </span>
                    {(s.coach || s.venue) && (
                      <span className="text-xs sm:text-right" style={{ opacity: 0.65 }}>
                        {[s.coach, s.venue].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
