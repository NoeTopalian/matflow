# NOTES-L4 — identity.spec.ts

Companion to `tests/e2e/campaign/identity.spec.ts`. Read the gaps section before
you read the green ticks; two of the four fixes are covered less completely than
a passing run makes them look, and one of the four could not be tested in the
shape it was asked for because that shape asserts a bug.

---

## How to run it

```
npx playwright test tests/e2e/campaign/identity.spec.ts --workers=1
```

`--workers=1` is not optional. Two tests SUSPEND the shared seeded club for a few
seconds. `playwright.config.ts` sets `fullyParallel: true` and `workers: 4`
locally, so any other spec that logs in during that window is refused at the door
and fails for a reason that has nothing to do with it.

`test.describe.configure({ mode: "serial" })` inside the file stops the tests in
this file racing each other. It does nothing about the other 40-odd spec files —
only `--workers=1` does.

Cost of serial mode: a failure skips every test after it. If you would rather see
all six results than stop at the first red, change `mode: "serial"` to
`mode: "default"` **and keep `--workers=1`**, which is what was actually holding
the suspension safe.

---

## Selectors, and where each one comes from

Nothing here was guessed. Every string was read out of the component that renders
it.

| Used for | Selector | Source |
|---|---|---|
| Email step reached | `input[type='email']` | `app/login/page.tsx:626` (mirrors `tests/e2e/auth.setup.ts:17`) |
| Password field | `input[type='password']` | `app/login/page.tsx:654-656` — note the attribute is `type={showPw ? "text" : "password"}`, so the selector holds only while the reveal toggle is off (its default) |
| Submit | `button[type='submit']` | `app/login/page.tsx:697` |
| Credentials refusal | `getByRole("alert")` contains `Incorrect email or password.` | set at `app/login/page.tsx:399`, rendered in the `role="alert"` div at `app/login/page.tsx:689` |
| Club-code step still showing | heading `Enter your club code` | `app/login/page.tsx:238-240` |
| Club-code input | `input[aria-label='Club code']` | `app/login/page.tsx:247` |
| Club lookup refusal | text `Club not found. Check your code and try again.` | `lib/login-lookup.ts:40` (the 4xx branch), rendered at `app/login/page.tsx:270` |
| Staff dashboard rendered | `a[href="/dashboard/members"]` (`.first()`) | `components/layout/routes.ts:51`, rendered by `components/layout/Sidebar.tsx` |
| Member portal reached | URL matches `/member` | `app/login/page.tsx:407` routes members to `/member/home` |
| Profile page loaded | heading `Profile` | `app/member/profile/page.tsx:171` |
| Member's own identity | `getByText(member.name, { exact: true }).first()` | `app/member/profile/page.tsx:249` — the `<p>` that only renders once `profileLoaded` is true |
| Profile failure surface | text `Couldn't load your profile — tap retry.` | `app/member/profile/page.tsx:161`, rendered in the `role="alert"` banner at `app/member/profile/page.tsx:175` |

`.first()` on the dashboard nav because `app/dashboard/layout.tsx` renders
`Sidebar` (line 74) before `MobileNav` (line 156) and both emit the same hrefs;
MobileNav is CSS-hidden at desktop width. `.first()` on the member name because
`AvatarUploader` is also handed `name` for its initials.

---

## Where this file arranges state outside the browser, and why that is honest

Two places, both following `helpers/db.ts`'s rule — **arrange in SQL, act in the
browser, assert in the browser.**

1. **`makeLoginable(memberId)`** sets a bcrypt hash of `password123` and
   `onboardingCompleted = true`. A staff-created member has no password (they are
   invited), and the first-run wizard is a full-screen blocker over the portal.
   Neither is the thing under test.

2. **The `MagicLinkToken` row** is inserted directly. See the gap below.

Deliberately NOT used: `tests/e2e/onboarding-gate.ts`'s
`suppressOnboardingWizard`. It intercepts `/api/member/home` and rewrites the
payload. On a V-5 test, rewriting the response from the endpoint under test is
exactly the wrong instrument.

Two things in the spec are *not* SQL arrangement and should not be mistaken for
it — the mixed-case member is created through `POST /api/members` (the app's own
write path, with the owner's real session cookie, because the WRITE is the fix),
and the magic link is consumed by navigating to it.

---

## GAPS — what this file does not prove

### 1. The mixed-case test could not be written in the shape it was asked for

The brief asked for: *create a member via the helper with a mixed-case email,
then log in lowercase and uppercase.*

**That test would assert a bug, and it would fail.** Here is the chain:

- `prisma/migrations/20260913230000_lowercase_emails` is a **one-off backfill**.
  Two `UPDATE` statements. No trigger, no `citext`, no `CHECK`, no unique index
  on `lower(email)`.
- `Member.email` is plain `TEXT`, and Postgres `=` on `TEXT` is case-sensitive.
- `auth.ts:95` now parses the submitted address through `emailField()`, which
  lowercases it, and looks it up with
  `tenantId_email: { tenantId, email }` (`auth.ts:216`).

So a row inserted into Postgres *after* that migration with capitals in it is
looked up as lowercase, does not match, and **cannot sign in under any
spelling** — not the mixed one, not the lower one. Before the fix, the mixed
spelling worked (the lookup used the raw string); after it, nothing does. The
backfill healed the rows that existed on 13 Sep and nothing stops a new one
appearing by any route that does not go through `emailField()`.

What the spec does instead, which is the actual fix:

1. The owner adds a member through `POST /api/members` and **types** the address
   with capitals — the real-world case, off a paper sign-up sheet.
2. Assert the **stored** value is lowercase (`memberCreateSchema` →
   `emailField()`, `lib/schemas/member.ts:39`). This is the fix, at the layer the
   fix was made.
3. Then log in through the browser with the lowercase spelling and the uppercase
   spelling, each in its own signed-out context, and land in the portal both
   times.

**Residual risk this leaves open, and it is real:** nothing in the product
*enforces* lowercase at the database. Any write path that bypasses `emailField()`
— a future route, a CSV importer, a support script, a manual `UPDATE` — silently
recreates a permanently unrecoverable account, and now it cannot even log in. A
`CREATE UNIQUE INDEX ... ON "Member" (lower("email"), "tenantId")` plus a
`CHECK (email = lower(email))` would make the invariant the database's problem
rather than every author's. That is a code change, so it is out of scope here,
but it is the thing worth doing next.

### 2. Session revocation and the 10-minute cache — testable, with one caveat

It IS testable in a browser inside a sensible time, and the spec does it. The
route round it is not a cheat, but you should know exactly what it is.

`auth.ts:702-732` gates the revocation DB round-trip behind
`SESSION_VERSION_RECHECK_INTERVAL_MS` (10 min), keyed on
`token.sessionVersionCheckedAt`. That claim is stamped at mint time
(`auth.ts:602`), so a session created by a password login genuinely does not
recheck for ten minutes.

But `shouldRecheck` is `!checkedAt || Date.now() - checkedAt > INTERVAL` — **a
token carrying no stamp at all rechecks on its very first request.** Two real
session types are in that state:

- **Every magic-link session.** `app/api/magic-link/verify/route.ts:109-147`
  hand-rolls its JWT payload and never sets the claim. Read both branches of
  `jwtPayload` — it is absent from each.
- **Every ordinary session older than ten minutes**, which is all of them, for
  all but the first ten minutes of thirty days.

So `mintStaffSessionCookie()` encodes a token in auth.ts's own shape and omits
`sessionVersionCheckedAt`. The first request then performs the real check against
the real database, and the only variable between the two V-3 tests is whether the
staff row still exists.

**The caveat:** the spec does not prove the *cache itself* behaves — i.e. that a
freshly-minted password session survives ten minutes and then revokes. Proving
that needs either a ten-minute wall-clock wait or a clock injection point the app
does not have. If you want it, the honest way is to make
`SESSION_VERSION_RECHECK_INTERVAL_MS` configurable via env and drive it to `0` in
`.env.test`. Until then: **the window is untested, and a removed coach keeps a
working dashboard for up to ten minutes.** That is by design and materially
better than the thirty days the bug allowed, but it is not zero, and
`SettingsPage.tsx` still tells the owner the removal is immediate.

**The control test earns its place.** `/login` is where a malformed token, a
wrong secret and a stale cookie name all end up too. Without the present-row
control, the deleted-row test would pass on any of them.

Also note: `proxy.ts` runs at the edge, where the revocation block is skipped
(`process.env.NEXT_RUNTIME !== "edge"`, Prisma is Node-only). The middleware
waves the token through; the Node-runtime dashboard layout is what kills it. If
`toHaveCount(0)` on the dashboard nav passes but `toHaveURL(/\/login/)` fails,
revocation worked and the failure surface is an error page instead of a redirect
— a finding about `lib/authz.ts:33`, not a false negative.

### 3. The magic-link REQUEST half is not covered

`lib/token-hash.ts` stores `HMAC-SHA256(raw, AUTH_SECRET)`. The raw value exists
in exactly two places: the outbound Resend email, and — with `RESEND_API_KEY`
unset — `console.log` on the **dev server's** stdout
(`app/api/magic-link/request/route.ts:96`), a process this spec neither owns nor
can read.

So the spec mints the token row itself, writing it exactly as
`request/route.ts:73-83` writes one: same hash function, same lowercased email,
same 30-minute expiry, same `purpose: "login"`, `used: false`.

**Not covered, therefore:** the request route's rate limit (3 per 15 min), its
anti-stockpile invalidation of prior unused tokens, its `passwordHash IS NOT
NULL` exclusion of kid sub-accounts, its silent-200 anti-enumeration behaviour,
and the email actually being sent. **Covered end to end:** the verify half — the
half V-5 broke.

Covering the request half honestly needs a mail sink (Mailpit / a Resend test
inbox) or a test-only endpoint that returns the raw token. Both are code changes.

### 4. `/member/home` is NOT a V-5 surface — do not "simplify" the test onto it

This one nearly went in and would have been a spec that passed for the wrong
reason.

`app/api/member/home/route.ts:144` reads:

```ts
if (session.user.tenantId === "demo-tenant" || !memberId) {
  return NextResponse.json(demoHome(session.user.name));
}
```

A memberId-less session gets **HTTP 200 and demo data, greeted by the name on its
own token.** With the V-5 bug fully in place, `/member/home` renders and says the
member's name. Any assertion there is green over the defect.

`/api/member/me` is the honest one: `app/api/member/me/route.ts:87-90` answers
404 `"No member record for this session"`, and
`app/member/profile/page.tsx:145` throws on a non-ok response and swaps the
identity card for the retry banner. That is why the V-5 proof navigates on to
`/member/profile`.

(Separately: that demo fallback is worth a second look. It is a UI-RULES §7
violation of the same family the rest of the codebase has been stamping out —
fabricated data served at 200 to a real tenant whose session is broken.)

### 5. A suspended club's refusal does not say why, and cannot

`app/login/page.tsx` **never reads `?error=` from the URL.** Nothing in that file
touches `searchParams.get("error")`.

Consequences:

- The password door collapses every failure into
  `"Incorrect email or password."` (`app/login/page.tsx:399`), so the spec proves
  the user is **refused**, not that they are told the club is suspended.
- `app/api/magic-link/verify/route.ts:88` redirects a suspended club to
  `/login?error=tenant_suspended`, and `auth.ts:491` does the same for Google.
  **Both land on a login page that silently ignores the parameter** and, with no
  `?club=`, renders the bare club-code step. The admission decision is correct;
  the message `admissionMessage()` was written to carry (`lib/tenant-admission.ts:58-68`)
  reaches nobody.

That is a product gap, not a test gap. The owner of a suspended club is told
their own password is wrong.

### 6. The Google door is untested

`lib/tenant-admission.ts` is called from all three doors and the spec exercises
two of them (password at `auth.ts:204`, magic link at
`app/api/magic-link/verify/route.ts:86`). The Google path (`auth.ts:489`) needs
`ENABLE_GOOGLE_OAUTH=true` plus real GCP credentials, and Google's own consent
screen is not drivable from Playwright without a service account. Unit coverage
of `tenantAdmission()` is the only realistic guard there.

### 7. Member-side revocation is untested

`checkSessionVersion` takes the `memberId` branch for member sessions
(`lib/session-revocation.ts:73`). The spec only exercises the `userId` branch. A
hard-deleted MEMBER keeping a working portal is the same defect and is not
covered here. It would be a near-copy of the V-3 pair using a member row and a
member-shaped token; it was left out to keep the file's suspension window short,
not because it is uninteresting.

### 8. `hashToken` is duplicated, and can go stale silently

The spec reimplements `lib/token-hash.ts` (six lines of HMAC) instead of
importing it. No spec under `tests/e2e/**` imports through the `@/` alias, so
none of them demonstrates that Playwright's transform resolves `tsconfig` paths,
and `@/lib/token-hash` pulls in `@/lib/auth-secret`'s import-time production
guard as well.

**If `lib/token-hash.ts` ever changes algorithm or salt, the magic-link test
starts failing with "invalid_link" and nothing will say why.** If you touch that
file, touch this one.

Same shape of duplication, same warning: `SESSION_COOKIE_NAME`
(`lib/auth-cookie.ts`) and the `NEXTAUTH_SECRET ?? AUTH_SECRET` precedence
(`lib/auth-secret.ts:4` — inverting it signs with a different key than the server
verifies with).

### 9. The secret is read out of `.env`, carefully

`playwright.config.ts` loads `.env.test`, which carries only the test-branch
`DATABASE_URL` and the E2E flags — **no auth secret**. The dev server gets its
secret from `.env`. The spec therefore reads `.env`, but with
`dotenv.parse(readFileSync(...))` into a **local object**, never
`dotenv.config()`. `.env` also holds the production `DATABASE_URL` and this suite
writes; nothing from that file is allowed into `process.env`.

If you ever add `AUTH_SECRET` to `.env.test`, it must be the **same value** the
dev server signs with or the minted cookies stop decoding.

### 10. Residue this file does not clean

`test.afterAll` runs `cleanupRun()` and then deletes this run's
`MagicLinkToken` and `User` rows by the `RUN_STAMP` email prefix. (Safe to delete
the users directly: `AuditLog.userId` is `ON DELETE SET NULL` and
`LoginEvent.userId` is `ON DELETE CASCADE`.)

Left behind: the `auth.magic_link.consume` **`AuditLog`** row written by
`app/api/magic-link/verify/route.ts:156`, with a dangling `entityId` pointing at
a deleted member. Harmless, append-only, and matched by
`metadata->>'email' LIKE '<stamp>-%'` if you ever want to sweep it.

Also: `POST /api/members` counts against a 30-creates-per-hour bucket keyed on
tenant + user (`app/api/members/route.ts:155`). One create per run; only relevant
if you loop this file dozens of times in an hour.

---

## Summary of verdicts

| Fix | Proved through a browser? |
|---|---|
| **V-3** missing row ⇒ revoked | **Yes**, with a present-row control. The 10-minute window itself is NOT proved — see gap 2. |
| **V-5** magic-link `memberId` | **Yes**, on `/member/profile`. The verify half only; the request half is not covered — gaps 3 and 4. |
| **Email case** | **The fix is proved** (write normalises; both spellings sign in). The brief's shape was not writable — gap 1. Nothing enforces the invariant at the database. |
| **Tenant admission** | **Password and magic-link doors: yes.** Google: no. The refusal carries no reason to the user — gaps 5 and 6. |
