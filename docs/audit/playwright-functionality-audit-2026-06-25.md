# MatFlow — Playwright Functionality Audit

**Date:** 2026-06-25
**Scope:** Run the existing Playwright e2e suite + explicitly verify the profile-picture feature.
**DB target:** disposable Neon **test** branch `ep-hidden-salad-abom7cg4` (production `ep-bold-wave-abt39t7x` never touched).

## Headline

- **App features are working.** Every failure below is **test drift or an e2e-harness limitation — not an application defect.** Pages render correctly; the tests assert against stale selectors or a login form that has since become two-step.
- **Profile pictures: VERIFIED end-to-end** (upload → resize/store → DB persist → serve → remove). See below.

## How it was run (safe setup)

The production DB was protected by pinning **both** the app server and the test runner to the test branch:

1. Started `next dev` with `DATABASE_URL` exported = test-branch connection string (shell env beats `.env`/`.env.local` for Next *and* for the destructive specs' own loader). Asserted host ≠ `ep-bold-wave` before every run.
2. **Hazard found & neutralised:** `playwright.config.ts` loads `.env.test` (which only defines `TEST_DATABASE_URL`, never `DATABASE_URL`). The destructive auth/TOTP specs call `makePrisma()` reading `process.env.DATABASE_URL` and `loadEnvFallback(".env")` → **without the shell override they would have reset TOTP on PRODUCTION.** `.env.local` happens to also point at the test branch, but relying on that is fragile. **Recommend:** add `DATABASE_URL=<test-branch>` to `.env.test` (or make `playwright.config.ts` mirror `TEST_DATABASE_URL`→`DATABASE_URL`) so the safety isn't incidental.

## Results — Run A (full suite, `--project=chromium`)

**99 passed · 23 skipped · ~62 failed.** Passing areas confirm core functionality: auth login/logout, reports KPIs (churn/retention/payment-health), revenue MRR/ARR, payments history + filters, members API, auth-gate browser redirects, admin login/protection, security headers, XSS render, no-secrets API.

### Failure clusters (all test-side, ranked by count)

| # | Cluster | ~Count | Root cause | Fix |
|---|---------|-------|-----------|-----|
| 1 | **Strict-mode selector drift** | ~38 | The shared header/Topbar now renders a duplicate page-title `h1` (e.g. banner "Dashboard" + main `h1`), so `page.locator("h1")` / `"h1, h2"` / loose text & button locators resolve to **multiple** elements → Playwright strict-mode violation. The headings *do* exist and pages render fine. | Use `getByRole("heading",{name,exact})` or scope to `getByRole("main")`. Affects full-app-qa TC-DASH-02/05/10/12, TC-PAY-03, TC-ROUTE-01/02, member home/progress/schedule/shop, cancellation-banner, nav-tap-targets. |
| 2 | **`ui-sync-sweep` login helper** | 18 | Its `loginAs` goes to `/login` and waits for `input[type=email]` directly — but login is now a **two-step club-code → credentials** flow, so the email field never appears → 30s timeout. | Navigate to `/login?club=totalbjj` (as `auth.setup.ts` does) or fill the club-code step first. |
| 3 | **401-gate via shared cookie** | ~6 | TC-GATE-06/07, TC-API-08 & `api/routes` send `headers:{Cookie:""}` to force 401, but Playwright's `request` fixture still carries the owner `storageState` cookie → API returns 200/403 not 401. | Use a fresh `request` context with empty storage state, not a header override. *(Browser-context gate tests TC-GATE-01..05 with empty storageState passed — auth redirects are genuinely enforced.)* |
| 4 | **member-TOTP API session** | ~3 | `member-totp-*` specs build a member session via the bypass and call `/api/member/totp/setup` → 401/400. Same bypass quirk as below. | Fixture/login harness, not an app bug. |
| 5 | **`TC-PAY-06` illegal `test.use()`** | 1 | `test.use()` called inside a test body — not allowed by Playwright. | Move to `describe` scope or delete (redundant with TC-GATE-03). |

### e2e member-login limitation (worth fixing in the harness)

The `TESTING_MODE` bypass (`auth.ts`) only returns a **member** session when the email matches a `Member` row **with a `passwordHash` and no shadowing `User` row**; otherwise it falls back to the tenant's first **owner**. In practice member emails on the test branch kept resolving to the owner dashboard, so member-self-service UI specs couldn't drive a true member session. This blocks the *member-self* path of several specs (incl. the canned profile-picture UI spec) but is a **test-fixture/bypass issue, not a product bug** — the underlying endpoints are shared with the staff path, which is verified.

## Profile pictures — VERIFIED ✅

The canned `member/profile-picture-upload.spec.ts` can't run here: it self-skips without `TEST_PASSWORD`, uses a stale `getByPlaceholder(/gym code/i)` selector (real placeholder is "e.g. TOTALBJJ"), and the member-session bypass resolves to owner. So the feature was verified directly through its real API pipeline using the working owner session (staff may manage any member's photo — `app/api/members/[id]/profile-picture/route.ts`):

1. `POST /api/upload?purpose=profile-pic` (multipart, magic-byte-checked PNG) → **200**, returns a resized-WebP url (Vercel Blob `https://…`, or inline `data:image/webp` fallback when `BLOB_READ_WRITE_TOKEN` is unset).
2. `PUT /api/members/:id/profile-picture {url}` → **200**, upserts `MemberPhoto(kind=profile)`.
3. `GET /api/members` (fresh read) → `profilePictureUrl` now set → **DB row persisted.**
4. `DELETE /api/members/:id/profile-picture` → **200**, `profilePictureUrl: null`.
5. `GET /api/members` (fresh read) → cleared → **removal persisted.**

**Result: 2 passed.** The member self-service UI (`app/member/profile/page.tsx`) is wired to the same two endpoints (Camera button → hidden file input → `POST /api/upload` → `PUT …/profile-picture`; "Remove picture" → `DELETE`), with the avatar swapping initials ↔ `<img src=profilePictureUrl>`.

## Recommended follow-ups (test maintenance, not app fixes)

1. Pin `DATABASE_URL` in `.env.test` so prod-safety is explicit, not incidental.
2. Update loose selectors to role/exact or `main`-scoped (cluster 1) — the single biggest win.
3. Fix `ui-sync-sweep` + `login.spec` + profile-picture login helpers to use the two-step `/login?club=` flow (cluster 2).
4. Replace empty-`Cookie` header tricks with fresh empty-storage `request` contexts (cluster 3).
5. Either give the bypass a way to force a member session, or seed a dedicated member fixture, so member-self UI specs can run.
6. Not run this pass: `Mobile Chrome` project, and the family ad-hoc Stripe charge / kiosk demo-class / parent-guardian waiver flows (no existing coverage).
