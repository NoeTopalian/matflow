# Sean Handover — Test Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open verification gap between today's build and a Total BJJ owner account Sean can be handed, and fix the one policy conflict that gap analysis exposed.

**Architecture:** Three kinds of work, deliberately separated because they fail differently. (1) One real code change: member-side family mutation must be removed and enforced server-side. (2) Test debt: 20 of the 29 assess files are unrun or partially run, and 53 e2e specs sit outside that lane entirely. (3) New contracts the handover prompt introduces that have no tests at all — CSV export fidelity, mail-dark behaviour, provisional-email identity, and recovery under mail-dark with mandatory MFA. Everything is gated behind a healthy database connection, because the 2 October sweep proved an unhealthy one makes all results meaningless.

**Tech Stack:** Next.js 16, Playwright (`--project=chromium --workers=1`, one file per invocation), Vitest, Prisma + Neon Postgres, NextAuth v5.

**Spec:** `docs/superpowers/plans/2026-10-02-sean-handover-spec.md` — save the attached `MatFlow-Sean-First-Handover-Execution-Prompt.md` there before starting. Executors read both.

## Global Constraints

- Playwright: always `--project=chromium --workers=1`, **one spec file per invocation**. Two files in one run produced phantom failures on 2 Oct.
- Never run e2e without `.env.test` present; `tests/e2e/global-setup.ts` refuses `ep-bold-wave` outright and must stay that way.
- Never start a dev server with bare `next dev` or `npm run dev`. Use the x6 launcher pattern: load `.env.test` with `override: true`, assert the URL contains `ep-hidden-salad` and not `ep-bold-wave`, then spawn.
- `npm run build` locally invokes `scripts/maybe-migrate.mjs`; it refuses production unless `VERCEL_ENV=production`, but do not rely on that — do not run it against `.env`.
- `git push origin main` is a production deploy **and** a `prisma migrate deploy`. Never push as housekeeping.
- British English in all user-facing copy.
- Do not loosen a test, raise a hook timeout, or relabel blocked coverage to make a tally green. A 30-second budget for a bucket clear is a correct expectation; record that the environment failed it.
- Never place Sean's temporary password in source, logs, fixtures, screenshots, Markdown or commits.
- Report `NOT RUN` as its own state. It is neither passed nor failed.

## Review Focus

Five conditions the spec implies that no current test exercises, most likely to bite first:

1. **A parent forging `parentMemberId` or `accountType` in a self-service profile PATCH.** Expected: refused, row unmoved. Pinned in Task 2.
2. **A parent calling `DELETE /api/member/children/[id]` for their own child.** Expected: refused — removal is an administrator action. Pinned in Task 2.
3. **A revoked guardian with a live session and a warm cached page.** Expected: access gone on the next request, not at next login. Pinned in Task 4.
4. **A CSV export containing a name with a comma, a leading-zero phone number, and a cell beginning `=`.** Expected: parses back identically, no formula execution, no corrupted contact value. Pinned in Task 8.
5. **A member-facing flow that depends on email while Resend is disabled.** Expected: an honest unavailable state, never a "sent" or "invited" claim. Pinned in Task 9.

---

## File Structure

**Code changes (Tasks 1–4):**
- Modify: `app/api/member/children/route.ts` — remove `POST`; it currently mints a confirmed link under plain `auth()`.
- Modify: `app/api/member/children/[id]/route.ts` — `PATCH` keeps only approved dependent fields; `DELETE` becomes staff-only.
- Modify: `app/api/member/me/route.ts` — reject forged `parentMemberId`, `accountType`, `guardianConfirmedAt`, `guardianSuggestedBy`.
- Create: `lib/family-authority.ts` — one predicate naming who may mutate a relationship, so the rule lives in one place.
- Modify: member portal family UI — hide the add/unlink controls that the API will now refuse.
- Create: `tests/unit/family-authority.test.ts`, `tests/e2e/campaign/assess/lc-4-family-authority.spec.ts`.

**Verification only (Tasks 5–11):** no source changes; each produces an evidence file under `docs/readiness/evidence/`.

---

## Phase 0 — Unblock the environment

### Task 1: Prove the database connection is fit before anything else

**Files:**
- Create: `scripts/readiness/db-latency-gate.mjs`
- Create: `docs/readiness/evidence/db-latency-2026-10-XX.txt`

**Interfaces:**
- Produces: `scripts/readiness/db-latency-gate.mjs`, exits 0 when median round-trip < 400 ms over 10 samples, exits 1 otherwise and prints the median.

- [ ] **Step 1: Write the gate script**

```js
// scripts/readiness/db-latency-gate.mjs
import { config } from "dotenv";
import { Client } from "pg";
config({ path: ".env.test", override: true });
const url = process.env.DATABASE_URL ?? "";
if (!url.includes("ep-hidden-salad") || url.includes("ep-bold-wave")) {
  console.error("REFUSING: DATABASE_URL is not the test branch");
  process.exit(2);
}
const samples = [];
for (let i = 0; i < 10; i++) {
  const t = Date.now();
  const c = new Client({ connectionString: url });
  try { await c.connect(); await c.query("select 1"); samples.push(Date.now() - t); }
  catch (e) { console.error(`sample ${i + 1}: FAIL ${e.message}`); samples.push(Infinity); }
  finally { try { await c.end(); } catch {} }
}
samples.sort((a, b) => a - b);
const median = samples[Math.floor(samples.length / 2)];
console.log(`samples(ms): ${samples.join(", ")}`);
console.log(`median: ${median}ms`);
if (!(median < 400)) { console.error("GATE FAILED: median >= 400ms — e2e results would be noise"); process.exit(1); }
console.log("GATE PASSED");
```

- [ ] **Step 2: Run it on the current connection and expect failure**

Run: `node scripts/readiness/db-latency-gate.mjs`
Expected on 2 Oct's connection: `GATE FAILED`, median around 1,400–2,700 ms. This reproduces the blocker rather than assuming it.

- [ ] **Step 3: Move to a sound connection and re-run until it passes**

Options in order of preference: a UK network rather than the Italian one; a wired connection; a Neon branch in a nearer region. Record which one was used.

Run: `node scripts/readiness/db-latency-gate.mjs > docs/readiness/evidence/db-latency-2026-10-XX.txt`
Expected: `GATE PASSED`.

- [ ] **Step 4: Commit**

```bash
git add scripts/readiness/db-latency-gate.mjs docs/readiness/evidence/db-latency-2026-10-XX.txt
git commit -m "test(readiness): a database-latency gate that refuses to run e2e on a connection that makes results noise"
```

**Do not begin any later task until this gate passes.** Every failure in the 2 October sweep traces to this.

---

## Phase 1 — The family-authority code change

### Task 2: Members and parents cannot mutate a relationship

**Files:**
- Create: `lib/family-authority.ts`
- Create: `tests/unit/family-authority.test.ts`
- Modify: `app/api/member/children/route.ts` (remove `POST`)
- Modify: `app/api/member/children/[id]/route.ts` (`PATCH` field allow-list, `DELETE` staff-only)
- Modify: `app/api/member/me/route.ts` (reject forged family fields)

**Interfaces:**
- Produces: `MAY_MUTATE_FAMILY: readonly ["owner", "manager"]`; `assertMayMutateFamily(role: string | undefined): void` which throws `FamilyAuthorityError` otherwise; `DEPENDENT_EDITABLE_FIELDS: readonly string[]`.
- Consumes: nothing from earlier tasks.

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/unit/family-authority.test.ts
import { describe, it, expect } from "vitest";
import { assertMayMutateFamily, DEPENDENT_EDITABLE_FIELDS, FamilyAuthorityError } from "@/lib/family-authority";

describe("family authority", () => {
  it("lets an owner and a manager mutate a relationship", () => {
    expect(() => assertMayMutateFamily("owner")).not.toThrow();
    expect(() => assertMayMutateFamily("manager")).not.toThrow();
  });

  it("refuses a coach, an admin, a member and an absent role", () => {
    for (const role of ["coach", "admin", "member", undefined]) {
      expect(() => assertMayMutateFamily(role)).toThrow(FamilyAuthorityError);
    }
  });

  it("never lets a dependent edit reach a relationship or identity column", () => {
    for (const forbidden of ["parentMemberId", "accountType", "guardianConfirmedAt", "guardianSuggestedBy", "tenantId"]) {
      expect(DEPENDENT_EDITABLE_FIELDS).not.toContain(forbidden);
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/family-authority.test.ts`
Expected: FAIL — cannot resolve `@/lib/family-authority`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// lib/family-authority.ts
/**
 * 2 Oct 2026: parent/child relationships are managed by authorised club
 * administrators, never by members or parents themselves. One predicate so the
 * rule cannot drift between routes.
 */
export const MAY_MUTATE_FAMILY = ["owner", "manager"] as const;

/** Fields a parent may edit on a child already assigned to them. */
export const DEPENDENT_EDITABLE_FIELDS = ["name", "dateOfBirth", "medicalConditions", "photoUrl"] as const;

export class FamilyAuthorityError extends Error {
  constructor() { super("Family relationships are managed by club staff."); this.name = "FamilyAuthorityError"; }
}

export function assertMayMutateFamily(role: string | undefined): void {
  if (!role || !(MAY_MUTATE_FAMILY as readonly string[]).includes(role)) throw new FamilyAuthorityError();
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run tests/unit/family-authority.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Remove the member-side create path**

In `app/api/member/children/route.ts`, delete the `POST` handler entirely and leave a comment in its place:

```ts
// POST removed 2 Oct 2026: a member creating a child minted a CONFIRMED_BY
// guardian link under plain auth(), which let a parent grant themselves
// guardian authority. Creating a child is now staff-only —
// POST /api/members with accountType "kids", then
// POST /api/members/[id]/link-child (both requireApiOwner).
```

Remove the now-unused `CONFIRMED_BY` and `MAX_KIDS_PER_PARENT` imports if nothing else in the file uses them.

- [ ] **Step 6: Narrow the dependent routes**

In `app/api/member/children/[id]/route.ts`: in `PATCH`, build the update object only from `DEPENDENT_EDITABLE_FIELDS` and ignore every other key; in `DELETE`, call `assertMayMutateFamily(session.user.role)` before any work and answer 403 via `apiError` on `FamilyAuthorityError`.

In `app/api/member/me/route.ts`: before the update, reject the request with 400 if the body carries any of `parentMemberId`, `accountType`, `guardianConfirmedAt`, `guardianSuggestedBy`, `tenantId`.

- [ ] **Step 7: Run the whole unit suite for regressions**

Run: `npx vitest run`
Expected: PASS, no failures. Baseline on 2 Oct was 2,849 passed / 0 failed.

- [ ] **Step 8: Commit**

```bash
git add lib/family-authority.ts tests/unit/family-authority.test.ts app/api/member/children/route.ts app/api/member/children/\[id\]/route.ts app/api/member/me/route.ts
git commit -m "fix(family): only owners and managers may change a relationship — a parent can no longer mint their own guardian link"
```

### Task 3: Hide the controls the API now refuses

**Files:**
- Modify: `components/member/EditChildModal.tsx` — remove its create mode; it POSTs `/api/member/children` when opened with `kid=null`, which Task 2 deletes.
- Modify: `components/member/FamilySection.tsx:75` — remove the control that calls `fetch('/api/member/children/<id>', { method: "DELETE" })`.
- Leave untouched: `components/dashboard/OwnerFamilyManagement.tsx` — this is the staff surface and it correctly keeps Add child, Link existing and Unlink.
- Test: `tests/e2e/campaign/assess/lc-4-family-authority.spec.ts` (created in Task 4)

**Interfaces:**
- Consumes: `MAY_MUTATE_FAMILY` from Task 2.

- [ ] **Step 1: Remove the member-side create mode**

In `components/member/EditChildModal.tsx`, make the modal edit-only: drop the `kid=null` create branch and its submit path, and keep the edit path limited to `DEPENDENT_EDITABLE_FIELDS`. Where a parent previously saw an Add child button, render one sentence instead: `Ask your club to add a child to your family.`

- [ ] **Step 2: Remove the member-side delete**

In `components/member/FamilySection.tsx`, delete the handler at line 75 and the control that invokes it. A parent removing their own child is an administrator action now.

- [ ] **Step 3: Confirm no member surface still calls a mutating family route**

Run: `grep -rn "member/children" app/member/ components/ | grep -iE "POST|DELETE|method:"`
Expected: no POST or DELETE against `member/children`.

- [ ] **Step 4: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 0 errors; every UI-RULES ratchet at or below baseline.

- [ ] **Step 5: Commit**

```bash
git commit -am "fix(family): the member portal no longer offers relationship controls the API refuses"
```

### Task 4: End-to-end proof of family authority

**Files:**
- Create: `tests/e2e/campaign/assess/lc-4-family-authority.spec.ts`

**Interfaces:**
- Consumes: `mkMember`, `mkKid`, `teardownSeededClub`, `sql`, `seededTenantId`, `RUN_STAMP` from `tests/e2e/campaign/assess/lf-shared.ts`.

- [ ] **Step 1: Write the failing spec**

Cover, each as its own `test(...)`:

```ts
// 1. An owner assigns, reassigns and removes a link — each proven by a row read.
// 2. A parent POSTing /api/member/children is 403 or 404 and writes no row.
// 3. A parent DELETEing /api/member/children/<ownChildId> is 403; the row survives.
// 4. A parent PATCHing /api/member/me with { parentMemberId: <otherAdult> } is 400; the column is unmoved.
// 5. A parent PATCHing /api/member/children/<ownChildId> with { accountType: "adult" } leaves accountType "kids".
// 6. Two adults sharing one email address get no guardian authority over each other's children.
// 7. A sibling set: a parent sees exactly their own two children and no third child.
// 8. Another tenant's parent gets 404 on this club's child and reads nothing.
// 9. After the owner reassigns a child, the OLD parent's existing session is refused on the
//    next request to /api/member/children/<id> and the child is gone from /api/member/me/children.
// 10. The member portal family page renders no Add child, Unlink or Link existing control.
```

Each API assertion reads the row back with `sql(...)` afterwards — a refusal is proven by the database, not by the status code alone.

- [ ] **Step 2: Run it and confirm the pre-fix failures**

Run: `npx playwright test tests/e2e/campaign/assess/lc-4-family-authority.spec.ts --project=chromium --workers=1`
Expected before Tasks 2–3: cells 2, 3, 4, 5 and 10 FAIL. If they pass, the fix landed already — check before writing more code.

- [ ] **Step 3: Run it again after Tasks 2–3 and expect green**

Run: same command.
Expected: all 10 pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/campaign/assess/lc-4-family-authority.spec.ts
git commit -m "test(family): administrator-only relationship authority, proven at the route and in the row"
```

---

## Phase 2 — Finish the assess lane

### Task 5: Re-run the four files the bad connection damaged

**Files:** none modified. Evidence: `docs/readiness/evidence/assess-rerun-2026-10-XX.log`

- [ ] **Step 1: Restart the test server cold through the x6 launcher**

A three-hour-old dev server was contributing to the cold-compile timeouts. Start a fresh one on the test branch before this task.

- [ ] **Step 2: Run each of the four, one invocation each, recording the tally**

```bash
for f in lb-1-club-setup lb-3-ownership-and-integrations lc-1-members lc-2-family-invites-waivers; do
  npx playwright test "tests/e2e/campaign/assess/$f.spec.ts" --project=chromium --workers=1 --reporter=line \
    2>&1 | tail -5 | sed "s/^/$f: /" | tee -a docs/readiness/evidence/assess-rerun-2026-10-XX.log
done
```

Expected: `lb-1` 29 passed (it lost 27 to a `beforeAll` timeout), `lb-3` 11–12 passed (it lost 1 to DNS), `lc-1` 27 passed (its 2 failures were an `afterAll` timeout), `lc-2` 16 passed (it lost 10 to a hook).

- [ ] **Step 3: If any file fails again, classify before retrying**

A hook timeout or `getaddrinfo` is environmental — re-run Task 1's gate. An assertion failure is a finding: record it, do not re-run hoping it passes.

- [ ] **Step 4: Commit the evidence**

```bash
git add docs/readiness/evidence/assess-rerun-2026-10-XX.log
git commit -m "docs(readiness): the four assess files the 2 Oct connection damaged, re-run clean"
```

### Task 6: Run the sixteen assess files that have never run

**Files:** none modified. Evidence: `docs/readiness/evidence/assess-remaining-2026-10-XX.log`

- [ ] **Step 1: Run each, one invocation each**

Files, in order: `lc-3-import-photos-cards`, `ld-1-timetable`, `ld-2-attendance`, `le-1-cash-and-tiers`, `le-2-refund-and-packs`, `le-3-webhooks-and-billing`, `lf-2-pages-and-push`, `lf-3-month-end`, `lg-1-operator-plane`, `lg-2-impersonation`, `lg-3-machines-and-sweep`, `lh-1-clublife-pause-leave-return`, `lh-2-clublife-families`, `lh-3-clublife-door`, `lh-4-clublife-transitions`, `lh-5-clublife-families-quality`.

```bash
for f in lc-3-import-photos-cards ld-1-timetable ld-2-attendance \
         le-1-cash-and-tiers le-2-refund-and-packs le-3-webhooks-and-billing \
         lf-2-pages-and-push lf-3-month-end \
         lg-1-operator-plane lg-2-impersonation lg-3-machines-and-sweep \
         lh-1-clublife-pause-leave-return lh-2-clublife-families \
         lh-3-clublife-door lh-4-clublife-transitions lh-5-clublife-families-quality; do
  npx playwright test "tests/e2e/campaign/assess/$f.spec.ts" --project=chromium --workers=1 --reporter=line \
    2>&1 | tail -5 | sed "s/^/$f: /" | tee -a docs/readiness/evidence/assess-remaining-2026-10-XX.log
done
```

Expected: a tally per file. `lc-3` needs `BLOB_READ_WRITE_TOKEN`; without it, record BLOCKED, not failed.

- [ ] **Step 2: Name every skipped cell**

The line reporter does not print skip reasons. For any file reporting skips, re-run that file with `--reporter=list` and record each skipped test's name and its `UNCOVERED — …` reason. This includes the three already known: one in `a0-3-the-week`, two in `a0-5-month-end-and-leaving`.

- [ ] **Step 3: Write the lane summary**

Create `docs/readiness/evidence/assess-lane-2026-10-XX.md` with one row per file: passed / failed / skipped / not-run, and for each skip its named reason. A skip is a coverage gap, recorded as such.

- [ ] **Step 4: Commit**

```bash
git add docs/readiness/evidence/
git commit -m "docs(readiness): the full 29-file assess lane with every skip named"
```

### Task 7: Run the 53 specs outside the assess lane

**Files:** none modified. Evidence: `docs/readiness/evidence/e2e-outside-lane-2026-10-XX.log`

The 29-file pass has never covered these, and they include the auth lifecycle, admin plane, security headers, kiosk, and the UI audits.

- [ ] **Step 1: Enumerate them**

Run: `find tests/e2e -name "*.spec.ts" | grep -v "campaign/assess" | grep -v "audit/harvest" | sort`
Expected: 52 files (`audit/harvest.spec.ts` is excluded by design — it asserts nothing and only runs under `AUDIT_HARVEST=1`).

- [ ] **Step 2: Run each, one invocation each, same loop shape as Task 6**

Expected: a tally per file. `ui-audit-overlap.spec.ts` is in the default matrix and is slow; do not disable it.

- [ ] **Step 3: Triage every failure into finding or environment, with the error text quoted**

- [ ] **Step 4: Commit the evidence**

---

## Phase 3 — The contracts with no tests

### Task 8: CSV export fidelity

**Files:**
- Create: `tests/e2e/campaign/assess/lc-5-csv-export-fidelity.spec.ts`
- Create: `docs/readiness/evidence/csv-export-contract-2026-10-XX.md`

**Interfaces:**
- Consumes: `mkMember`, `sql`, `seededTenantId`, `RUN_STAMP` from `lf-shared.ts`.

- [ ] **Step 1: Inventory what the product actually offers**

Run: `grep -rln "text/csv\|Content-Disposition" app/api/ | sort`
Record each export route, which role may call it, and whether it is audited. Write the inventory into the evidence file before testing — the spec requires stating which formats exist and what the source lacks.

- [ ] **Step 2: Write the failing spec**

Seed members whose values are the hostile cases, then download through the UI and parse the saved bytes independently:

```ts
// Seed: a name with a comma ("Coates, Sean"), a name with a quote (O'Brien),
// a multiline note, a phone "07700 900123" and a postcode "0A1 1AA",
// a field beginning "=HYPERLINK(" and one beginning "+447700900123".
// Assert: round-trips byte-identically through a CSV parser; the leading zero
// survives; the "=" cell is neutralised (prefixed per the product's guard) while
// "+447700900123" is NOT corrupted; headers are stable; UTF-8 is intact;
// blank is distinguishable from zero; every filter-matching row is present with
// no silent cap; the row count equals the same filter read straight from the DB.
```

- [ ] **Step 3: Run it**

Run: `npx playwright test tests/e2e/campaign/assess/lc-5-csv-export-fidelity.spec.ts --project=chromium --workers=1`
Expected: the formula-injection and leading-zero cells are the likely failures. Record exactly which.

- [ ] **Step 4: Fix only what fails, smallest change, then re-run**

- [ ] **Step 5: Record the exact compatibility claim**

In the evidence file state plainly what is and is not true: which exports exist, whether any is reimportable into MatFlow, and that **no claim is made about importing back into TeamUp** unless that format was separately verified.

- [ ] **Step 6: Commit**

### Task 9: Mail-dark behaviour is honest

**Files:**
- Create: `tests/e2e/campaign/assess/lc-6-mail-dark.spec.ts`

- [ ] **Step 1: Write the failing spec**

```ts
// With RESEND_API_KEY absent, assert for each email-dependent surface
// (bulk invite, single invite, waiver link, member password reset,
//  owner import-complete notice):
//   - the UI shows an explicit unavailable state in plain British English
//   - no response claims "sent", "invited", "emailed" or "delivered"
//   - no Resend request is attempted (assert on a network route interception)
//   - the audit row, if any, records the attempt honestly and not a delivery
```

- [ ] **Step 2: Run it, record failures, fix the copy or the state, re-run**

- [ ] **Step 3: Commit**

### Task 10: Provisional-email identity and mail-dark recovery

**Files:**
- Create: `tests/e2e/auth/provisional-owner-identity.spec.ts`
- Create: `docs/readiness/evidence/recovery-procedure-2026-10-XX.md`

Rehearse all of this on a **disposable** owner. Never enrol an authenticator on Sean's permanent account.

- [ ] **Step 1: Write the failing spec**

```ts
// 1. A provisional (unverified) login email works for password sign-in only.
// 2. It receives nothing, and no flow marks it verified.
// 3. A magic link or external IdP cannot grant access to an unverified identifier.
// 4. Before password change AND authenticator confirmation, every protected page
//    redirects and every /api route answers 403 JSON — persisted server-side.
// 5. After an authorised email change: same immutable user id, same owner
//    assignment, same audit actor, same enrolled MFA factor; the old login fails;
//    superseded tokens and sessions are invalidated.
// 6. Rollback of that change restores the prior identifier with the same guarantees.
// 7. A staff-assisted factor reset forces fresh enrolment before club access and
//    writes an audit row naming the actor and the reason.
```

- [ ] **Step 2: Run, fix, re-run**

- [ ] **Step 3: Document the recovery procedure**

Write who may authorise a reset, how identity is verified without email, what is audited, and which sessions and credentials are revoked. A staff-assisted reset must not become an unaudited MFA bypass.

- [ ] **Step 4: Commit**

---

## Phase 4 — Evidence only Noe can produce

### Task 11: The four owner-held gates

**Files:** `docs/readiness/evidence/production-gates-2026-10-XX.md`

None of these can be produced by an agent. Each is a named production-readiness dependency until it exists.

- [ ] **Step 1: Confirm `TESTING_MODE` and `DEMO_MODE` are unset or false in Vercel production**, and record a screenshot-free note of the result. The release package marks this mandatory before a real owner account exists.
- [ ] **Step 2: Record the deployed SHA** from Vercel deployment metadata; no route exposes it.
- [ ] **Step 3: Run the production runtime-role query** — is the app's role `BYPASSRLS`? Record the answer. Restricted-role test evidence is not production configuration evidence (ADR-001 D8).
- [ ] **Step 4: Perform one Neon point-in-time restore rehearsal** into a separate branch and reconcile a sample of restored rows. Until this exists, recovery is untested.
- [ ] **Step 5: Confirm `BLOB_READ_WRITE_TOKEN` is set**, and set `CRON_SECRET` only after reading the retention `?dryRun=1` preview.
- [ ] **Step 6: Commit the evidence file**

---

## Phase 5 — Independent acceptance

### Task 12: A fresh reviewer, not the implementer

**Files:** `docs/readiness/evidence/independent-acceptance-2026-10-XX.md`

- [ ] **Step 1: Dispatch a reviewer with no part in Tasks 1–11**, given the spec and the evidence files, not the implementer's summary.
- [ ] **Step 2: Have it walk the §6 acceptance list** on the deployed build with a disposable owner, and return a verdict per line.
- [ ] **Step 3: Record the verdict as READY FOR SEAN or BLOCKED**, reserving ACTIVATED for Sean's own completed MFA login.
- [ ] **Step 4: Commit**

---

## What this plan does not do

- It does not import the real TeamUp CSV into production. That is the handover prompt's §5 and needs Sean's export time and tier prices plus Noe's go.
- It does not claim a timetable, attendance history or signed waivers can be migrated. The membership CSV contains none of them; Sean sets the timetable up himself.
- It does not enable Resend. That is separate work, and enabling it must not become a side effect.
