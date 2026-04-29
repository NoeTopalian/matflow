# /dashboard/members/[id]

| | |
|---|---|
| **File** | app/dashboard/members/[id]/page.tsx |
| **Section** | dashboard |
| **Auth gating** | Auth required; page-level `requireStaff()` |
| **Roles allowed** | owner / manager / coach / admin |
| **Status** | ✅ working |

## Purpose
Full profile page for a single member. Shows all profile fields (name, email, phone, DOB, status, payment status, membership type, account type, emergency contact, medical conditions, waiver status + timestamp), the last 50 attendance records, full payment ledger, rank achievement history, class subscriptions, and notes. Staff can edit any profile field, record a manual payment, add a rank award, mark the member inactive, or resend the waiver link. All mutations are transactional. The `MemberProfile` component is the largest in the codebase (~1500 lines).

## Inbound links
- [/dashboard/members](members.md) — row click in MembersList (`router.push(\`/dashboard/members/${m.id}\`)`)

## Outbound links
- [/dashboard/members](members.md) — back button in MemberProfile (`router.push("/dashboard/members")`)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.member.findFirst | Fetch member with ranks, last 50 attendances, subscriptions (server-side) |
| — | prisma.rankSystem.findMany | Fetch rank options for the rank-award dropdown (server-side) |
| PATCH | /api/members/[id] | Update member profile fields |
| POST | /api/payments/manual | Record a manual payment (transactional) |
| POST | /api/members/[id]/rank | Award a new rank to the member |
| GET | /api/members/[id]/payments | Fetch full payment ledger |

## Sub-components
- MemberProfile ([components/dashboard/MemberProfile.tsx](../../../components/dashboard/MemberProfile.tsx)) — full client component; all edit forms, payment ledger, rank history, attendance list, notes, "More actions" menu

## Mobile / responsive
- Form grid uses `grid-cols-1 sm:grid-cols-2`. Attendance/payment tables scroll horizontally on mobile.

## States handled
- `notFound()` if member ID does not belong to the tenant or DB error occurs.
- Loading/error states handled within MemberProfile client component.

## Known issues
- **P2 open** — No optimistic concurrency on PATCH; simultaneous edits by two staff members silently overwrite each other — see docs/AUDIT-2026-04-27.md WP-E.

## Notes
The "Resend waiver link" action in the "More actions" menu depends on `RESEND_API_KEY` being set; the button is present regardless and will return an error if email is not configured. The "Message" button was removed in the US-008 deslop pass (was dead JSX).
