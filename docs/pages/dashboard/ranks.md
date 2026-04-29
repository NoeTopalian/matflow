# /dashboard/ranks

| | |
|---|---|
| **File** | app/dashboard/ranks/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireRole(["owner", "manager", "coach"])` — admin explicitly excluded |
| **Roles allowed** | owner / manager / coach |
| **Status** | ✅ working |

## Purpose
CRUD interface for rank system templates. Ranks are grouped by discipline (BJJ, Judo, Wrestling, etc.) and ordered by `order` index. Each rank has a name, colour, discipline, order, and maximum stripes. Staff use this to define the belt/rank progression available for awarding to members on the member detail page. Changes here affect the rank options shown in `/dashboard/members/[id]` and `/onboarding` (rank preset step).

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Ranks" nav item
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Ranks" in the More drawer

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.rankSystem.findMany | Fetch all tenant ranks ordered by discipline + order (server-side) |
| POST | /api/ranks | Create a new rank |
| PATCH | /api/ranks/[id] | Update rank name, colour, order, or stripes |
| DELETE | /api/ranks/[id] | Delete a rank |

## Sub-components
- RanksManager ([components/dashboard/RanksManager.tsx](../../../components/dashboard/RanksManager.tsx)) — client-side CRUD UI grouped by discipline

## Mobile / responsive
- Mobile-aware card layout.

## States handled
- Empty list: friendly empty state in RanksManager.
- DB error: empty array passed silently.

## Known issues
— none blocking

## Notes
Admin is excluded from this page by design (`requireRole(["owner", "manager", "coach"])`). The `role` prop is passed to `RanksManager` to potentially show/hide actions per role, though all three permitted roles currently see the same UI.
