# Ranks Management

> **Status:** ✅ Working · per-tenant rank systems · soft-delete preserves member history · stripe count tracking · audit-logged promotions.

## Purpose

Define belt systems (BJJ: White → Black, with stripes; or any custom progression — Judo, Karate, MMA). Members are pinned to a `MemberRank`; promotions append to `RankHistory` for an audit trail.

## Surfaces

- Page: [/dashboard/ranks](../app/dashboard/ranks/page.tsx)
- Component: [RanksManager](../components/dashboard/RanksManager.tsx)
- Tabs by discipline (e.g. "BJJ" tab)
- Per-rank actions: reorder up/down, edit, delete
- Header: "Use Preset" (BJJ default) · "Add Rank"
- Member promotion: from member detail page, NOT here — see [member-detail.md](member-detail.md)

## Data model

```prisma
model RankSystem {
  id         String    @id @default(cuid())
  tenantId   String
  discipline String       // "BJJ" | "Judo" | tenant-defined
  name       String       // "White Belt"
  order      Int          // 1 = lowest, 5 = highest
  color      String?
  stripes    Int       @default(0)   // max stripes before next belt
  deletedAt  DateTime?

  @@unique([tenantId, discipline, order])  // no duplicate order per discipline
  @@index([tenantId, deletedAt])
}

model MemberRank {
  id           String     @id @default(cuid())
  memberId     String
  rankSystemId String
  stripes      Int       @default(0)
  achievedAt   DateTime  @default(now())
  promotedById String?    // FK User who awarded — see LB-007 enrichment

  @@unique([memberId, rankSystemId])  // one rank per member per discipline
}

model RankHistory {
  id           String     @id @default(cuid())
  memberRankId String
  fromRankId   String?    // NULL on first belt
  toRankId     String
  promotedAt   DateTime   @default(now())
  promotedById String?
  notes        String?
}
```

## API

- `GET /api/ranks` — list per discipline, default-filtered `where: { deletedAt: null }`
- `POST /api/ranks` — owner/manager. Creates rank + auto-orders.
- `PATCH /api/ranks/[id]` — edit name/color/stripes/order
- `DELETE /api/ranks/[id]` — soft-delete (`deletedAt = now`). Members keep their existing `MemberRank` rows; the rank just disappears from the editor.
- `POST /api/members/[id]/rank` (member route) — promote a member, appends `RankHistory` row.

## Security

- All writes require owner/manager
- Tenant-scoped (`tenantId` on every query)
- Soft-delete preserves historical attribution — past members keep their belt visible in their profile even after the rank system is restructured
- Promotion audit-logged: `logAudit({ action: "member.rank.promote", entityId: memberId, metadata: { fromRankId, toRankId } })`

## Known limitations

- **No "auto-promote on stripes" rule.** When a member hits 4 stripes on White Belt, they don't auto-jump to Blue — staff has to manually promote. Could be a tenant setting.
- **No member-facing rank request** — only staff can promote.
- **Reorder is fragile** if multiple admins edit at once — no optimistic concurrency on the order field.

## Files

- [app/dashboard/ranks/page.tsx](../app/dashboard/ranks/page.tsx)
- [components/dashboard/RanksManager.tsx](../components/dashboard/RanksManager.tsx)
- [app/api/ranks/route.ts](../app/api/ranks/route.ts)
- [app/api/ranks/[id]/route.ts](../app/api/ranks/[id]/route.ts)
- [app/api/members/[id]/rank/route.ts](../app/api/members/[id]/rank/route.ts)
