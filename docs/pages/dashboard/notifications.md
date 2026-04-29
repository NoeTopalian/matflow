# /dashboard/notifications

| | |
|---|---|
| **File** | app/dashboard/notifications/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireOwnerOrManager()` — coaches and admin excluded |
| **Roles allowed** | owner / manager |
| **Status** | ✅ working |

## Purpose
Create, pin, edit, and delete gym-wide announcements that appear to members on `/member/home`. Lists up to 50 announcements ordered pinned-first then newest. Each announcement has a title, body text, optional image URL, pinned flag, and creation date. The page is the owner/manager-side counterpart to the announcements feed members see on their home screen.

## Inbound links
- Sidebar ([components/layout/Sidebar.tsx](../../../components/layout/Sidebar.tsx)) — "Notifications" nav item (owner/manager only)
- MobileNav ([components/layout/MobileNav.tsx](../../../components/layout/MobileNav.tsx)) — "Notifications" in the More drawer

## Outbound links
— (self-contained)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.announcement.findMany | Fetch up to 50 announcements ordered pinned-first (server-side) |
| POST | /api/announcements | Create a new announcement |
| PATCH | /api/announcements/[id] | Edit an existing announcement or toggle pinned |
| DELETE | /api/announcements/[id] | Delete an announcement |

## Sub-components
- AnnouncementsView ([components/dashboard/AnnouncementsView.tsx](../../../components/dashboard/AnnouncementsView.tsx)) — client-side list with add/edit/delete/pin-toggle actions

## Mobile / responsive
- Mobile-aware. Card-based layout stacks vertically on all screen sizes.

## States handled
- Empty list: friendly empty state in AnnouncementsView.
- DB error: empty array passed silently (error caught without logging).

## Known issues
- **P2 open** — `/api/announcements/[id]` GET read-back after mutation uses `findUnique({where:{id}})` without tenant scope — safe in context but defensive tenant-scoping pending P3 cleanup — see OWNER_SITE_SUMMARY.md.

## Notes
Announcements are visible to members at `/member/home` via `GET /api/announcements` (tenant-scoped, public to authenticated members). The `AnnouncementsView` component receives the `role` prop but the route is already gated to owner/manager at the page level.
