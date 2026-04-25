# Open Questions

## initial-test-plan - 2026-04-18
- [ ] Should the streak extraction refactor (moving `getWeekKey`/`calculateStreak` to `lib/streak.ts`) be done as a prerequisite task or inline during test writing? -- Affects whether Tier 1.1 tests can be written without touching production code first.
- [ ] Is there a preferred test DB strategy for integration tests (in-memory SQLite vs. file-based test.db vs. Prisma's `--force-reset` on each run)? -- Affects Tier 2 setup complexity and CI speed.
- [ ] Should the `admin` role be allowed to create announcements? Currently excluded from `["owner", "manager"]` check in `app/api/announcements/route.ts`. -- If this is a bug rather than intentional, the test assertion in Tier 1.3 would change.
- [ ] Are there timezone concerns for the streak algorithm? `getWeekKey` uses `new Date()` local time. If the server runs in UTC but members are in BST, Monday boundaries shift. -- May need a Tier 1.1 test case for timezone edge.

## owner-onboarding-wizard - 2026-04-18
- [ ] Should the wizard persist partial progress to localStorage so that a page refresh mid-onboarding doesn't lose state? -- Currently scoped as not needed for MVP (one-time flow), but could frustrate owners on slow connections.
- [ ] Should disciplines without rank presets (Boxing, Muay Thai, MMA, Kickboxing, Other) allow inline custom rank creation in the wizard, or just direct users to Settings later? -- Affects step 3 complexity; current plan defers to Settings.
- [ ] Should the "Go to Dashboard" CTA on the completion screen force a full page reload (window.location) vs. client-side router.push? -- A full reload ensures the JWT/session picks up any name/theme changes made during onboarding; router.push may show stale session data in the topbar.

## member-portal-5-bugs - 2026-04-18
- [ ] H13 role union — should we also narrow `interface JWT.role` to the union, or leave as `string`? -- Narrowing JWT would require changes in `authorize()` return types and the demo-fallback branch; currently out of scope, but leaving mismatch (User/Session narrowed, JWT not) is inconsistent.
- [ ] H13 role normalization — should unknown/typoed roles (e.g. `"Superuser"`) be rejected (return `null` session) or passed through lowercased? -- Spec says "normalize" only, so pass-through is chosen; if stricter validation is wanted, add a runtime allowlist check.
- [ ] C5 `/api/member/classes` — should we include a `lastAttended` timestamp in the response so Progress can show "last attended Mar 12"? -- Not in spec, but trivial addition; current plan omits it.
- [ ] C1 schedule page — should `classInstanceId` (now available from API) be plumbed into `EventSheet` to enable self-check-in from the Subscribe button? -- Out of scope per spec; noted for follow-up.
- [ ] H3 check-in deeplink — when `?class=` matches a real class but *not today* (no instance for today), should we redirect / show a toast, or silently fall back to `instances[0]`? -- Current plan: silent fallback. Revisit if UX testing shows confusion.
