# Deep Dive Trace: i-want-everything-on-the

## Observed Result
Full app audit requested: connection points, auth, member & owner UI, settings persistence (color/font/logo), contrast/readability, and a working plan.

## Ranked Hypotheses
| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | Member auth identity gap — `memberId` never set in session | High | Strong | Breaks all member-specific API calls; confirmed by 2 independent lanes |
| 2 | Settings reactivity — admin dashboard shows stale theme after save | High | Strong | ThemeProvider reads session frozen at login; member app works but admin doesn't |
| 3 | Instance generation ID mismatch — upsert always creates, never updates | High | Moderate | Hardcoded ID pattern incompatible with cuid() default |

## Evidence Summary by Hypothesis
- **Hypothesis 1 (member auth)**: `auth.ts` credentials provider never returns `memberId`. `types/next-auth.d.ts` doesn't declare it. `/api/member/me` reads `session.user.memberId` and silently falls back to demo data when undefined.
- **Hypothesis 2 (settings reactivity)**: `ThemeProvider` receives colors from server-session at render time. `SettingsPage.saveBranding()` saves to DB but doesn't refresh session or trigger re-render. `/api/settings` PATCH lacks `revalidatePath`. Member layout works correctly (fetches `/api/me/gym` on mount + listens to localStorage).
- **Hypothesis 3 (instance generation)**: `/api/instances/generate` constructs IDs as `inst-${classId}-${date}-${startTime}` for upsert WHERE clause, but `ClassInstance.id` defaults to `cuid()` — the pattern never matches existing records, so every generate call re-creates all instances.

## Evidence Against / Missing Evidence
- **Hypothesis 1**: Auth flow for staff (User model) is complete and correct. All dashboard routes are properly protected. The member portal may be intentionally demo-only at this stage.
- **Hypothesis 2**: The member app's theme handling is correct and complete — evidence suggests this was intentionally solved for members but left incomplete for the admin side.
- **Hypothesis 3**: Only affects timetable/scheduling features; doesn't block auth or settings.

## Per-Lane Critical Unknowns
- **Lane 1 (API connectivity)**: Whether `session.user.memberId` is intentionally undefined (design decision: separate member auth flow not yet built) or an oversight causing all member-profile calls to return demo data.
- **Lane 2 (Auth & session)**: Does the app actually have a member login flow (Member model credentials) or do members only access the portal via a magic link / QR / non-password method?
- **Lane 3 (Settings & UI)**: Whether the admin dashboard was intended to show live theme changes immediately after save, or require a page reload — and whether dark-on-dark contrast should be auto-corrected or user-controlled.

## Rebuttal Round
- **Best rebuttal to leader (member auth gap)**: Maybe member login is intentionally not implemented — the `app/member/` portal could be designed for staff previewing the member experience, not for real member login.
- **Why leader held**: The `/api/member/me`, `/api/member/schedule`, `/api/member/products`, `/api/member/checkout` routes all exist and expect a real authenticated member. The `Member` model has `passwordHash`. This is a feature under construction, not a preview.

## Convergence / Separation Notes
- Lanes 1 and 2 converged on the same root cause: **member identity is missing from the auth session**. Lane 1 found the symptom (broken API), Lane 2 found the root (auth flow gap).
- Lane 3 is fully independent — a reactivity/caching problem separate from auth.

## Most Likely Explanation
The member login flow is architecturally designed (Member model has passwordHash, member API routes exist) but the credentials provider in `auth.ts` was only built for staff (User model). Members can't actually log in yet — all member portal API calls silently fall back to demo data. In parallel, the admin dashboard theme doesn't refresh after settings save because the ThemeProvider reads stale session data.

## Critical Unknown
Does the member login need to share the same NextAuth credentials provider as staff, or should it be a separate auth path (e.g., `/member/login` → different signIn flow)?

## Recommended Discriminating Probe
Check `app/member/page.tsx` and `app/member/layout.tsx` for how member session is expected to be established — if there's a redirect to a member-specific login or a token-based entry point, the architecture is intentional; if it just calls `auth()` the same as the dashboard, the member credentials provider is simply missing.
