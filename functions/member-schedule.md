# Member Schedule

> **Status:** ✅ Working · 7-day swipeable pager (Mon-Sun) · hourly time-grid 7am-10pm · subscribe/unsubscribe with optimistic UI · custom touch handler for native-feeling horizontal swipes.

## Purpose

The member's "what classes are on this week?" view. Big readable time grid with class blocks positioned by start/end. Tap a block to see details and toggle subscription. Subscribed classes get a bell icon and a saturated background.

## Surfaces

- Page: [/member/schedule](../app/member/schedule/page.tsx)
- 3-panel swipeable strip (`prev day | current day | next day`) — touch handler at lines 348-414
- Day pills row (Mon-Sun, current week selectable; previous/next week via chevrons or swipe at week boundary)
- "Today" button to jump back to today's day pill
- Per-class detail sheet: time, location, coach, capacity, Subscribe / Unsubscribe button

## Layout details

- Time grid: 7am-10pm, hour rows (`HOUR_H = 64px`)
- Now indicator: red horizontal line at the current minute (today only)
- Class blocks positioned absolutely by `topPx(startTime)` + `heightPx(start, end)` — minimum 28 px tall so 30-min slots stay tappable
- Subscribed blocks: full saturated colour gradient + bell icon
- Unsubscribed: low-saturation tint, still readable

## Swipe gesture

Custom touch handler ([page.tsx:348-414](../app/member/schedule/page.tsx#L348)) — not a 3rd-party lib:

- Decides horizontal vs vertical based on first 3 px of finger movement (with bias toward horizontal)
- Tracks finger in real time via `transform: translateX`
- 12% of viewport width = commit threshold; below = spring-back with overshoot easing
- Above threshold: snaps to next/prev panel, then silently re-anchors after state update so the strip can render the new "prev/curr/next" trio

## API routes consumed

- [`GET /api/member/schedule`](../app/api/member/schedule/route.ts) — returns flat array of `{ id, classId, scheduleId, name, color, startTime, endTime, coach, location, capacity, dayOfWeek, classInstanceId? }` — one row per ClassSchedule (so a class with two weekly slots produces two rows). Optional `?date=YYYY-MM-DD` adds the matching `classInstanceId` for self-checkin.
- [`GET /api/member/me/subscriptions`](../app/api/member/me/subscriptions/route.ts) — returns `{ classIds: string[] }`. Hydrates the local Set on mount.
- [`POST /api/member/class-subscriptions/[classId]`](../app/api/member/class-subscriptions/[classId]/route.ts) — subscribe
- [`DELETE /api/member/class-subscriptions/[classId]`](../app/api/member/class-subscriptions/[classId]/route.ts) — unsubscribe

## Optimistic toggle pattern

```ts
const toggle = async (id: string) => {
  const wasSubscribed = subscribed.has(id);
  setSubscribed(prev => {
    const n = new Set(prev);
    wasSubscribed ? n.delete(id) : n.add(id);
    return n;
  });
  try {
    await fetch(`/api/member/class-subscriptions/${id}`, {
      method: wasSubscribed ? "DELETE" : "POST",
    });
  } catch {
    // roll back on failure
    setSubscribed(prev => {
      const n = new Set(prev);
      wasSubscribed ? n.add(id) : n.delete(id);
      return n;
    });
  }
};
```

## Data model

```prisma
model ClassSubscription {
  id                   String   @id @default(cuid())
  memberId             String
  classId              String
  notificationsEnabled Boolean  @default(true)
  createdAt            DateTime @default(now())

  @@unique([memberId, classId])  // idempotent — duplicate POST is a no-op (P2002)
}
```

## Security

- All routes member-authed
- Tenant-scoped via `class.tenantId` join
- Subscribe/unsubscribe idempotent (Prisma P2002 catch in toggle endpoints)
- Rate-limit subscribe routes to prevent DoS via toggle spam (5/min/member should be ample)

## Known limitations

- **No notifications-toggle UI** — schema has `notificationsEnabled` per subscription but the UI doesn't expose it. All-or-nothing today via the global Notifications toggles in /member/profile.
- **Touch handler is hand-rolled** — no `react-use-gesture` or similar. Works well on iOS/Android but harder to extend (e.g. for pinch-to-zoom).
- **Per-instance cancellation invisible** — if owner cancels a single Thursday's No-Gi via `ClassInstance.isCancelled=true`, the member-side schedule still shows the recurring slot. Workaround: owner posts an Announcement.
- **Rank gating not surfaced** — the schedule shows every class even if `requiredRank` excludes the member; subscribe attempt would fail server-side. Better UX: grey-out + reason tooltip.

## Test coverage

- E2E: [tests/e2e/member/schedule.spec.ts](../tests/e2e/member/schedule.spec.ts)

## Files

- [app/member/schedule/page.tsx](../app/member/schedule/page.tsx) — page, DayGrid, EventSheet, swipe handler
- [app/api/member/schedule/route.ts](../app/api/member/schedule/route.ts)
- [app/api/member/me/subscriptions/route.ts](../app/api/member/me/subscriptions/route.ts)
- [app/api/member/class-subscriptions/[classId]/route.ts](../app/api/member/class-subscriptions/[classId]/route.ts)
- [prisma/schema.prisma](../prisma/schema.prisma) — `ClassSubscription`
