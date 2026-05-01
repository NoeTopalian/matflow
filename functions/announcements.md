# Announcements (Notice Board)

> **Status:** ✅ Working · gym-wide notice board · pinned-first ordering · per-member "seen at" tracking · in-app modal carousel on the member home.

## Purpose

Lets owners broadcast a short message + optional image to every member at the gym (regional comp registration, holiday closure, founding-member deal, seminar reminder). Members see them as a popup the first time they log in after a new post, and as an inline list on /member/home thereafter.

## Surfaces

| Surface | Path |
|---|---|
| Owner editor | [/dashboard/notifications](../app/dashboard/notifications/page.tsx) — labelled "Notifications" in the sidebar but is announcements |
| Editor component | [AnnouncementsView](../components/dashboard/AnnouncementsView.tsx) — list, new-post drawer, delete |
| Member modal | [AnnouncementModal](../components/member/AnnouncementModal.tsx) — auto-shows the latest unseen pinned announcement on member home |
| Member inline list | [app/member/home/page.tsx](../app/member/home/page.tsx) — Announcements section after Today's Classes |

## Data model

```prisma
model Announcement {
  id        String   @id @default(cuid())
  tenantId  String
  title     String
  body      String
  imageUrl  String?    // optional hero image (Vercel Blob)
  pinned    Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

Plus a per-member "last seen" timestamp on `Member`:

```prisma
lastAnnouncementSeenAt DateTime?
```

## API routes

### `GET /api/announcements`
Authed (any role). Returns tenant's announcements ordered by `pinned DESC, createdAt DESC`. The member-side variant attaches an `unseenCount` derived from `lastAnnouncementSeenAt`.

### `POST /api/announcements`
Owner/manager. Body: `{ title, body, imageUrl?, pinned? }`. Creates a row.

### `DELETE /api/announcements/[id]`
Owner/manager. Tenant-guarded.

### `POST /api/member/me/mark-announcements-seen`
Member. Stamps `Member.lastAnnouncementSeenAt = now`. Called when the member dismisses the modal or scrolls past the inline list.

## Flow

### Owner posts
1. Owner clicks **+ New Post** in the notifications page → drawer opens
2. Title + body required; image upload optional (uses [/api/upload](../app/api/upload/route.ts) — Vercel Blob)
3. Pin toggle (pinned posts always sort first)
4. Submit → `POST /api/announcements` → row appears at top of list

### Member sees
1. Member home calls `GET /api/announcements`
2. If `unseenCount > 0` AND there's a pinned post newer than `lastAnnouncementSeenAt`: AnnouncementModal pops up centred
3. Member dismisses → `POST /api/member/me/mark-announcements-seen` runs in the background
4. Inline list renders the rest below Today's Classes

## Security

- `requireOwnerOrManager()` on writes
- All reads/writes tenant-scoped
- Image uploads route through `/api/upload` (Vercel Blob, magic-byte validated)
- Audit log: `logAudit({ action: "announcement.create" | "announcement.delete" })`
- Body length cap should be enforced (verify Zod schema)

## Known limitations

- **No scheduling** — can't queue an announcement for "publish next Monday at 09:00".
- **No member targeting** — every announcement goes to every member. No "kids parents only" or "annual members only" segments.
- **No edit** — only create + delete. To fix a typo, owner deletes and re-posts (which re-pops the modal for everyone).
- **No analytics** — no "X% of members opened this".
- **Rich text** — body is plain text only. No formatting, links auto-detect via `lib/linkify.tsx`.

## Files

- [app/dashboard/notifications/page.tsx](../app/dashboard/notifications/page.tsx)
- [components/dashboard/AnnouncementsView.tsx](../components/dashboard/AnnouncementsView.tsx)
- [components/member/AnnouncementModal.tsx](../components/member/AnnouncementModal.tsx)
- [app/api/announcements/route.ts](../app/api/announcements/route.ts)
- [app/api/announcements/[id]/route.ts](../app/api/announcements/[id]/route.ts)
- [app/api/member/me/mark-announcements-seen/route.ts](../app/api/member/me/mark-announcements-seen/route.ts)
- [lib/linkify.tsx](../lib/linkify.tsx) — auto-link URLs in body text
