# Hub Login-Address Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. On approval, this file is copied to `docs/superpowers/plans/2026-10-12-hub-login-conflict-resolution.md` (plan mode allowed only this path).

**Goal:** The operator can resolve, from the admin hub, every kind of conflict that stops a club owner using an address as their login. Every screen says in plain words whether each record is a **club sign-in account (owner or staff)** or a **member record (gym customer)**.

**Architecture:** This extends the existing guided "Resolve conflict" flow (`components/admin/ConflictPanel.tsx`, live since `9272a21`). Today it handles one case, where a member record holds the address. Two cases dead-end:
- a **staff account** holds the address ("ask the club");
- **several records** hold it ("nothing can be resolved").

A new operator route moves a staff account's login address. It reuses the member route's safety pattern exactly:
- a step-up grant bound to the record and its version;
- an advisory-lock claim;
- a single conditional write;
- retiring tokens and ending sessions;
- the audit row in the same transaction.

The panel gains the staff path, a per-record path through duplicates, and one shared plain-language description of each record kind.

**Tech Stack:** Next.js 16 route handlers, Prisma 7 via `withRlsBypass`, zod, Vitest (unit, jsdom, and integration on the TEST branch in both roles), and Playwright on a production build against TEST.

**Spec:** Noe's request of 12 Oct 2026, 20:07 UK. Sean's conflict could not be finished from the hub, and the hub did not make clear whether a record was "member or admin". The live code reviewed for this plan:
- `app/api/admin/customers/[id]/login-email/check/route.ts`
- `app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts`
- `components/admin/ConflictPanel.tsx`
- `app/admin/tenants/[id]/LoginEmailCard.tsx`
- `lib/operator-step-up.ts`
- `lib/login-email.ts`

## Global Constraints
- British English in all copy (CLAUDE.md).
- Read `docs/UI-RULES.md` before any UI edit. Use primitives from `components/ui/` (`Button`, `Dialog`, `Checkbox`), not raw elements. Use a static class map, never dynamic class fragments.
- Every tenant query filters on `tenantId`. Operator routes use `withRlsBypass` like their neighbours. Never `new PrismaClient()`.
- Every operator mutation has these guards, in order:
  - same-origin;
  - `isAdminAuthed`;
  - refuse in a support session (`hasImpersonationCookie`);
  - DB rate limit `admin:tenant-action:${operatorId}:${ip}`, 20 per hour;
  - strict zod body;
  - preflight reads;
  - `requireStepUp` with a target from `stepUpTarget(tenantId, subjectId, "change")`;
  - one transaction: spend, re-read, version compare, `claimLoginIdentity`, conditional `updateMany`, `retireEmailBoundTokens`, `sessionVersion` bump, `logAudit({ tx, … })`.
- Never written by the new route: `passwordHash`, TOTP fields, recovery codes, role, `tenantId`, the owner row. Addresses never appear in audit rows (`emailDigest` only) or logs.
- Never let the staff path change the club owner. The owner keeps its own route.
- Run before claiming done: `npm run lint && npm test && npm run build` on Node 24. Run the integration files in both roles: `DATABASE_URL` and `RESTRICTED_DATABASE_URL` from `.env.test`, with a host guard on `ep-hidden-salad`.
- Release follows the established path: PR to `main` (the ruleset requires one), CI compared with the 17 inherited failures, Noe's explicit deploy approval, and a merge commit.

## Review Focus
1. **The holder has the owner's name.** This is Sean's case: his member record and his owner account are the same person. The panel must say "This is a different record from the owner's sign-in account" and must not imply a merge. Test in Task 4.
2. **The staff holder is the person currently signed in at the club,** for example a manager. The change ends their sessions. The confirm dialog must say so before the code is entered. Test in Task 4.
3. **The staff record changes between the check and the change**: a password reset, a role change or a new address. The route answers 409 "changed since you checked" and writes nothing. Test in Task 3.
4. **A staff holder is the club owner** (a second owner row, or the first owner). The route refuses with 409 and points to the owner flow. Test in Task 3.
5. **Duplicates.** After one record is moved, the re-check must show the remaining holders. The owner step stays unavailable until the address is free. Test in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `components/admin/record-kind.ts` (create) | ONE plain-language description of a holder kind, used by every hub surface |
| `lib/operator-step-up.ts` (modify) | New step-up action `staff.login_email`: its change schema and version digest |
| `app/api/admin/customers/[id]/login-email/check/route.ts` (modify) | Staff holders carry `version`; duplicates carry their holder list |
| `app/api/admin/customers/[id]/staff/[userId]/login-email/route.ts` (create) | Operator moves one non-owner staff account's login address |
| `components/admin/ConflictPanel.tsx` (modify) | Staff path, duplicates path, record-kind wording |
| `app/admin/tenants/[id]/LoginEmailCard.tsx` (modify) | The card heading says whose login this is |
| `docs/runbooks/OPERATOR-LOGIN-CONFLICTS.md` (create) | Operator runbook: the three cases, what each step does to each record |

---

### Task 1: One plain-language description of each record kind

**Files:**
- Create: `components/admin/record-kind.ts`
- Test: `tests/unit/record-kind.test.ts`

**Interfaces:**
- Produces: `describeRecordKind(kind: "user" | "member", role?: string): { title: string; badge: string; detail: string }`.
- Produces: `sameNameNote(holderName: string, ownerName: string): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/record-kind.test.ts
import { describe, it, expect } from "vitest";
import { describeRecordKind, sameNameNote } from "@/components/admin/record-kind";

describe("describeRecordKind", () => {
  it("names a staff account as a club sign-in account, with its role", () => {
    const d = describeRecordKind("user", "manager");
    expect(d.badge).toBe("Club sign-in account");
    expect(d.title).toBe("Staff account (manager)");
    expect(d.detail).toMatch(/signs in to the club's back office/);
  });
  it("names the owner role explicitly", () => {
    expect(describeRecordKind("user", "owner").title).toBe("Owner account");
  });
  it("names a member as a member record, never as an account", () => {
    const d = describeRecordKind("member");
    expect(d.badge).toBe("Member record");
    expect(d.title).toBe("Member (gym customer)");
    expect(d.detail).toMatch(/membership, attendance and payments/);
    expect(d.detail).not.toMatch(/back office/);
  });
});

describe("sameNameNote", () => {
  it("warns when the holder shares the owner's name (case and spacing ignored)", () => {
    expect(sameNameNote(" sean coates", "Sean  Coates")).toMatch(/different record from the owner's sign-in account/);
  });
  it("is silent for different names", () => {
    expect(sameNameNote("Pat Smith", "Sean Coates")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/record-kind.test.ts`
Expected: FAIL with "Failed to resolve import "@/components/admin/record-kind"".

- [ ] **Step 3: Implement**

```ts
// components/admin/record-kind.ts
// One plain-language description of who holds an address (owner request,
// 12 Oct 2026: "make whether it's the member or admin clear"). Every hub
// surface that names a holder uses this; nothing else invents its own words.

export type RecordKind = "user" | "member";

export function describeRecordKind(kind: RecordKind, role?: string): { title: string; badge: string; detail: string } {
  if (kind === "member") {
    return {
      badge: "Member record",
      title: "Member (gym customer)",
      detail: "A customer of the club: membership, attendance and payments. It may also be able to sign in to the member app.",
    };
  }
  const r = (role ?? "staff").toLowerCase();
  return {
    badge: "Club sign-in account",
    title: r === "owner" ? "Owner account" : `Staff account (${r})`,
    detail: "A person who signs in to the club's back office (dashboard) to run the club.",
  };
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function sameNameNote(holderName: string, ownerName: string): string | null {
  if (!holderName || norm(holderName) !== norm(ownerName)) return null;
  return "Same name as the owner, but this is a different record from the owner's sign-in account. Changing its address does not merge or delete anything.";
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `npx vitest run tests/unit/record-kind.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add components/admin/record-kind.ts tests/unit/record-kind.test.ts
git commit -m "feat(hub): one plain-language description of club sign-in accounts vs member records"
```

### Task 2: Step-up action for a staff account's login address

**Files:**
- Modify: `lib/operator-step-up.ts`. Edit the `STEP_UP_ACTIONS` list after `"member.contact_email"`, the `CHANGE_SCHEMAS` map, and the `stepUpVersion` switch.
- Test: `tests/unit/operator-step-up-staff-login-email.test.ts`

**Interfaces:**
- Produces: `StepUpAction` includes `"staff.login_email"`. Target = `stepUpTarget(tenantId, userId, "change")`. Change = `{ newEmail }`.
- Produces: `stepUpVersionDigestIn(tx, "staff.login_email", target)`. It returns a digest over `user:${id}:role=${role}:sv${sessionVersion}:email=${email}:pw=${passwordHash != null}`, or `null` when the user is not in that tenant **or is an owner**.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/operator-step-up-staff-login-email.test.ts
import { describe, it, expect } from "vitest";
import { isStepUpAction, canonicalStepUpChange, stepUpVersion } from "@/lib/operator-step-up";

const tx = (user: Record<string, unknown> | null) =>
  ({ user: { findFirst: async () => user } }) as never;

describe("staff.login_email step-up action", () => {
  it("is a known action with a { newEmail } change, normalised", () => {
    expect(isStepUpAction("staff.login_email")).toBe(true);
    expect(canonicalStepUpChange("staff.login_email", { newEmail: " Pat@Example.COM " })).toEqual({ newEmail: "pat@example.com" });
    expect(canonicalStepUpChange("staff.login_email", {})).toBeNull();
  });
  it("versions a non-owner staff account on role, session version, address and password presence", async () => {
    const v = await stepUpVersion(
      tx({ id: "u1", role: "manager", sessionVersion: 3, email: "Pat@x.com", passwordHash: "h" }),
      "staff.login_email",
      "t1/u1/change",
    );
    expect(v).toBe("user:u1:role=manager:sv3:email=pat@x.com:pw=true");
  });
  it("refuses to version an owner (owners use owner.login_email)", async () => {
    const v = await stepUpVersion(
      tx({ id: "u1", role: "owner", sessionVersion: 1, email: "o@x.com", passwordHash: "h" }),
      "staff.login_email",
      "t1/u1/change",
    );
    expect(v).toBeNull();
  });
  it("is null for a user outside the tenant", async () => {
    expect(await stepUpVersion(tx(null), "staff.login_email", "t1/u9/change")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/unit/operator-step-up-staff-login-email.test.ts`
Expected: FAIL. `isStepUpAction("staff.login_email")` is false.

- [ ] **Step 3: Implement.** Add these three pieces to `lib/operator-step-up.ts`.

```ts
// in STEP_UP_ACTIONS, after "member.contact_email":
  // A NON-OWNER staff account's login address, moved by the operator to free
  // an address for the owner (hub conflicts, 12 Oct 2026). Target =
  // stepUpTarget(tenantId, userId, "change"); change = { newEmail }.
  "staff.login_email",
```

```ts
// in CHANGE_SCHEMAS:
  "staff.login_email": z.object({ newEmail: emailField(120) }).strict(),
```

```ts
// in the stepUpVersion switch, after case "member.contact_email":
    case "staff.login_email": {
      if (!subjectId) return null;
      const u = await tx.user.findFirst({
        where: { id: subjectId, tenantId },
        select: { id: true, role: true, sessionVersion: true, email: true, passwordHash: true },
      });
      if (!u || u.role === "owner") return null;
      return `user:${u.id}:role=${u.role}:sv${u.sessionVersion}:email=${u.email.trim().toLowerCase()}:pw=${u.passwordHash != null}`;
    }
```

- [ ] **Step 4: Run it and confirm it passes.** Also run the existing step-up suites.

Run: `npx vitest run tests/unit/operator-step-up-staff-login-email.test.ts tests/unit/operator-step-up.test.ts`
Expected: PASS. The existing suite is unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/operator-step-up.ts tests/unit/operator-step-up-staff-login-email.test.ts
git commit -m "feat(step-up): staff.login_email action (non-owner staff only), versioned on role, session, address and password"
```

### Task 3: Operator route for moving a staff account's login address, and check-route detail

**Files:**
- Create: `app/api/admin/customers/[id]/staff/[userId]/login-email/route.ts`
- Modify: `app/api/admin/customers/[id]/login-email/check/route.ts`. In `describe()`, the user branch gets `version` from `stepUpVersionDigestIn(tx, "staff.login_email", stepUpTarget(tenantId, h.id, "change"))`. The `many` branch returns `{ kind: "many", count, holders: CheckedSingleHolder[] }`, with each holder described as for a single holder.
- Test: `tests/integration/operator-hub-staff-login-email-db.test.ts`, run in both roles.

**Interfaces:**
- Consumes: Task 2 `staff.login_email`. From `lib/login-email.ts`: `claimLoginIdentity`, `retireEmailBoundTokens`, `emailDigest`, `LoginIdentityTaken`, `LOGIN_EMAIL_REASON_MIN`.
- Produces: `POST /api/admin/customers/:id/staff/:userId/login-email`, body `{ newEmail, reason, version }`, header `x-matflow-step-up`. Responses:
  - 200 `{ ok, userId, sessionsRevoked: true, retired }`, or `{ ok, alreadyApplied: true, … }`;
  - 409 `{ result: "owner" | "stale" | "taken" | "managed" }`;
  - 404 for a club or user not found;
  - 400 for a bad body or the same address.
- Produces: audit action `admin.staff.login_email.changed`, metadata `{ reason, oldEmailDigest, newEmailDigest, role, sessionsRevoked: true, retired, sessionVersionAfter, version, unverified: true }`.
- Produces: the check response for a user holder includes `version`. `many` includes `holders`.

- [ ] **Step 0: Extract the shared fixtures.** Today they are inline in `tests/integration/operator-hub-conflict-db.test.ts`: the operator session from `issueOperatorSession`, grants from `issueStepUpGrant`, the `read`/`mint` helpers, and the tenant, owner and member builders.
  - Move them to `tests/integration/helpers/operator-hub.ts`, exporting `makeTenant(roleLabel)`, `makeOwner(tenantId, email)`, `makeStaff(tenantId, { email, role, withPassword })`, `makeMember(tenantId, { email })`, `operatorRequest(body, grant)`, `issueGrant(action, target, change)`, `checkAddress(tenantId, email)` (calls the check route and returns its JSON), `bumpSessionVersion(userId)`, `seedDuplicate(tenantId, email)` and `cleanup()`.
  - Make the existing test import them.
  - Run `npx vitest run tests/integration/operator-hub-conflict-db.test.ts` in both roles. It must still pass unchanged before going on.
- [ ] **Step 1: Write the failing integration test.** It runs against the TEST branch in both roles, and its fixtures are run-stamped.

```ts
// tests/integration/operator-hub-staff-login-email-db.test.ts
// Pattern, helpers and role switching copied from tests/integration/operator-hub-conflict-db.test.ts
// (same fixture builders: makeTenant, makeOwner, makeStaff, operatorRequest, issueGrant).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTenant, makeOwner, makeStaff, makeMember, operatorRequest, issueGrant, cleanup, checkAddress } from "./helpers/operator-hub";
import { POST as moveStaff } from "@/app/api/admin/customers/[id]/staff/[userId]/login-email/route";

describe.each(["owner-role", "restricted-role"])("staff login email (%s)", (role) => {
  let t: { tenantId: string; ownerId: string; staffId: string };
  beforeAll(async () => {
    const tenantId = await makeTenant(role);
    const ownerId = await makeOwner(tenantId, "owner@club.test");
    const staffId = await makeStaff(tenantId, { email: "shared@club.test", role: "manager", withPassword: true });
    t = { tenantId, ownerId, staffId };
  });
  afterAll(cleanup);

  it("check returns the staff holder with a version", async () => {
    const r = await checkAddress(t.tenantId, "shared@club.test");
    expect(r.holder).toMatchObject({ kind: "user", id: t.staffId, status: "manager" });
    expect(r.holder.version).toMatch(/^[a-f0-9]{64}$/);
  });

  it("moves the staff address, ends their sessions, retires tokens, audits; the address is then free", async () => {
    const { holder } = await checkAddress(t.tenantId, "shared@club.test");
    const body = { newEmail: "pat.manager@club.test", reason: "Club confirmed by call-back", version: holder.version };
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${t.staffId}/change`, { newEmail: body.newEmail });
    const res = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: t.staffId }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, userId: t.staffId, sessionsRevoked: true });
    const after = await checkAddress(t.tenantId, "shared@club.test");
    expect(after.free).toBe(true);
  });

  it("re-sending the same grant answers alreadyApplied and changes nothing twice", async () => {
    const staff4 = await makeStaff(t.tenantId, { email: "four@club.test", role: "coach", withPassword: true });
    const { holder } = await checkAddress(t.tenantId, "four@club.test");
    const body = { newEmail: "coach4@club.test", reason: "Club confirmed by call-back", version: holder.version };
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff4}/change`, { newEmail: body.newEmail });
    const first = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: staff4 }) });
    expect(first.status).toBe(200);
    const again = await moveStaff(operatorRequest(body, grant), { params: Promise.resolve({ id: t.tenantId, userId: staff4 }) });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it("refuses the owner with result owner (409) and writes nothing", async () => {
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${t.ownerId}/change`, { newEmail: "x@club.test" });
    const res = await moveStaff(
      operatorRequest({ newEmail: "x@club.test", reason: "should be refused", version: "0".repeat(64) }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: t.ownerId }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("owner");
  });

  it("refuses a stale version (record changed since the check) with 409 stale", async () => {
    const staff2 = await makeStaff(t.tenantId, { email: "two@club.test", role: "coach", withPassword: true });
    const { holder } = await checkAddress(t.tenantId, "two@club.test");
    await bumpSessionVersion(staff2); // helper: users.sessionVersion += 1
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff2}/change`, { newEmail: "coach2@club.test" });
    const res = await moveStaff(
      operatorRequest({ newEmail: "coach2@club.test", reason: "Club confirmed by call-back", version: holder.version }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: staff2 }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("stale");
  });

  it("refuses a target address already held (by a member) with 409 taken", async () => {
    await makeMember(t.tenantId, { email: "held@club.test" });
    const staff3 = await makeStaff(t.tenantId, { email: "three@club.test", role: "coach", withPassword: true });
    const { holder } = await checkAddress(t.tenantId, "three@club.test");
    const grant = await issueGrant("staff.login_email", `${t.tenantId}/${staff3}/change`, { newEmail: "held@club.test" });
    const res = await moveStaff(
      operatorRequest({ newEmail: "held@club.test", reason: "Club confirmed by call-back", version: holder.version }, grant),
      { params: Promise.resolve({ id: t.tenantId, userId: staff3 }) },
    );
    expect(res.status).toBe(409);
    expect((await res.json()).result).toBe("taken");
  });

  it("check lists every holder of a legacy duplicate", async () => {
    await seedDuplicate(t.tenantId, "dup@club.test"); // helper: raw insert of a member + staff on the same canonical address
    const r = await checkAddress(t.tenantId, "dup@club.test");
    expect(r.holder.kind).toBe("many");
    expect(r.holder.holders).toHaveLength(2);
    expect(r.holder.holders.every((h: { version?: string }) => /^[a-f0-9]{64}$/.test(h.version ?? ""))).toBe(true);
  });
});
```

`bumpSessionVersion` and `seedDuplicate` are one-statement `withRlsBypass` writes on the TEST branch, in the helper module from Step 0. `seedDuplicate` inserts a member and a staff user on the same canonical address with mixed case, which is the legacy shape the lock now prevents.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run tests/integration/operator-hub-staff-login-email-db.test.ts` with the TEST env.
Expected: FAIL. The route module does not exist.

- [ ] **Step 3: Implement the route.** Start from a copy of `app/api/admin/customers/[id]/members/[memberId]/contact-email/route.ts`, then make these exact substitutions.
  - **Header comment:** "Operator moves ONE non-owner staff account's login address …". List what is never written: `passwordHash`, TOTP, recovery codes, role, `tenantId`, the owner.
  - **Params:** `{ id: string; userId: string }`. `target = stepUpTarget(tenantId, userId, "change")`. `OUTCOME = "admin.staff.login_email.changed"`. Step-up action `"staff.login_email"` everywhere `"member.contact_email"` appears, including `appliedOutcome`'s `payload.act` check.
  - **Preflight:**

    ```ts
    const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, email: true, role: true } });
    if (!user) return { kind: "no_user" as const };
    if (user.role === "owner") return { kind: "owner" as const };
    if (managedAddress(newEmail)) return { kind: "managed_target" as const };
    if (normaliseEmail(user.email) === newEmail) return { kind: "same" as const };
    const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { userId } });
    if (claim.kind !== "none") return { kind: "taken" as const, claim };
    if ((await stepUpVersionDigestIn(tx, "staff.login_email", target)) !== version) return { kind: "stale" as const };
    return { kind: "ok" as const };
    ```

    It maps `no_user` to 404 "Staff account not found in this club.". It maps `owner` to 409 `{ error: OWNER_MESSAGE, result: "owner" }`, where `OWNER_MESSAGE = "This is the club owner's sign-in account. Use the owner's Login email card; nothing was changed."`.
  - **Transaction:**

    ```ts
    const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: [OUTCOME] });
    if (spend.kind === "replay") return { alreadyApplied: true as const, ...spend.outcome };
    const user = await tx.user.findFirst({
      where: { id: userId, tenantId },
      select: { id: true, email: true, role: true, sessionVersion: true },
    });
    if (!user || user.role === "owner") throw new StaleStaff();
    if ((await stepUpVersionDigestIn(tx, "staff.login_email", target)) !== version) throw new StaleStaff();
    const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { userId } });
    if (claim.kind !== "none") throw new LoginIdentityTaken(claim);
    const changed = await tx.user.updateMany({
      where: { id: userId, tenantId, email: user.email, role: { not: "owner" } },
      data: { email: newEmail, sessionVersion: { increment: 1 }, loginEmailProvisionalSince: new Date() },
    });
    if (changed.count !== 1) throw new StaleStaff();
    const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [user.email, newEmail] });
    await logAudit({
      tx, tenantId, userId: null, action: OUTCOME, entityType: "User", entityId: userId,
      metadata: {
        reason, role: user.role,
        oldEmailDigest: emailDigest(user.email), newEmailDigest: emailDigest(newEmail),
        unverified: true, sessionsRevoked: true, retired,
        sessionVersionAfter: user.sessionVersion + 1, version,
        result: { userId, sessionsRevoked: true, retired },
      },
      actAsUserId: ctx.operatorId, operatorId: stepUp.operatorId, requestId: stepUp.requestId, req,
    });
    return { userId, sessionsRevoked: true, retired };
    ```

    Error mapping matches the member route, with `StaleStaff` mapped to 409 `{ result: "stale" }` and the message "This staff account changed since you checked it, so nothing was changed. Check the address again.". `loginEmailProvisionalSince` is the existing `User` column that the owner route also stamps, so the new address shows as unverified.
- [ ] **Step 4: Implement the check-route change.**

  ```ts
  // describe(): user branch
  if (h.kind === "user") {
    const version = await stepUpVersionDigestIn(tx, "staff.login_email", stepUpTarget(tenantId, h.id, "change"));
    return { kind: "user", id: h.id, name: h.name, status: h.role, canSignIn: true, access: "password", link: `/dashboard/staff`, ...(version ? { version } : {}) };
  }
  // holder for many:
  claim.kind === "many"
    ? { kind: "many", count: claim.holders.length, holders: await Promise.all(claim.holders.map(describe)) }
    : await describe(claim)
  ```

  Widen `CheckedHolder`'s `many` variant in the route and in `ConflictPanel.tsx` to `{ kind: "many"; count: number; holders: Array<Exclude<CheckedHolder, { kind: "many" }>> }`.
- [ ] **Step 5: Run the integration file in both roles and the existing hub suites.**

  Run: `npx vitest run tests/integration/operator-hub-staff-login-email-db.test.ts tests/integration/operator-hub-conflict-db.test.ts tests/unit/operator-hub-conflict-routes.test.ts`, once with `DATABASE_URL` and once with `DATABASE_URL=$RESTRICTED_DATABASE_URL` (TEST only).
  Expected: all pass in both roles.
- [ ] **Step 6: Commit**

```bash
git add "app/api/admin/customers/[id]/staff/[userId]/login-email/route.ts" "app/api/admin/customers/[id]/login-email/check/route.ts" tests/integration/operator-hub-staff-login-email-db.test.ts tests/integration/helpers/operator-hub.ts
git commit -m "feat(hub): operator moves a non-owner staff account's login address (step-up, versioned, sessions ended, audited); check lists duplicate holders"
```

### Task 4: Panel paths for staff accounts and duplicates, and plain record labels

**Files:**
- Modify: `components/admin/ConflictPanel.tsx`
- Modify: `app/admin/tenants/[id]/LoginEmailCard.tsx`. The heading changes from "Login email" to "Owner's sign-in email (back office)". The description line reads "The address {owner name} uses to sign in to the club's dashboard. Not a member record.".
- Test: `tests/unit/conflict-panel.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1 `describeRecordKind` and `sameNameNote`. Task 3 check fields `holder.version` for `user`, and `holder.holders` for `many`. Task 3 route path.
- Produces: the panel's "Held by" row renders `describeRecordKind(...).badge` as a pill and `.title` as text, with `.detail` as a muted line. It renders `sameNameNote(holder.name, owner.name)` as a notice when it is non-null.

- [ ] **Step 1: Write the failing tests** (jsdom). Put these helpers at the top of the new `describe` block. If the file already has equivalents, reuse them under these names.

```tsx
import userEvent from "@testing-library/user-event";
const user = userEvent.setup();
const V = "a".repeat(64);
function renderPanel(over: Partial<{ holder: CheckedHolder; owner: { id: string; name: string } }>) {
  const result = { free: false, tenant: { id: "T", name: "Club" }, owner: over.owner ?? { id: "o1", name: "Owner" }, holder: over.holder };
  return render(<ConflictPanel tenantId="T" address="owner@club.test" initial={result as CheckResult} onClose={() => {}} />);
}
async function verifyAndStart() {
  await user.click(screen.getByRole("checkbox", { name: /verified the relationship independently/i }));
  await user.type(screen.getByLabelText(/How you verified it/), "Call-back to the club's number on file");
}
function mockFetchSequence(steps: { url: string; body: unknown; status?: number }[]) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const s = steps.find((x) => String(input).endsWith(x.url)) ?? steps[0];
    return new Response(JSON.stringify(s.body), { status: s.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
```

Check `ConflictPanel`'s actual props (`tenantId`, `address`, `initial`, `onClose`) against its export before running. If a prop name differs, use the real one in `renderPanel` and change nothing else.

```tsx
it("labels a member holder as a member record, and notes a shared name is a different record", async () => {
  renderPanel({ holder: { kind: "member", id: "m1", name: "Sean Coates", status: "cancelled", canSignIn: false, access: "none", link: "/x", version: V } , owner: { id: "o1", name: "Sean Coates" } });
  expect(screen.getByText("Member record")).toBeInTheDocument();
  expect(screen.getByText("Member (gym customer)")).toBeInTheDocument();
  expect(screen.getByText(/different record from the owner's sign-in account/)).toBeInTheDocument();
});

it("offers the staff path instead of a dead end, and warns the person will be signed out", async () => {
  renderPanel({ holder: { kind: "user", id: "u1", name: "Pat", status: "manager", canSignIn: true, access: "password", link: "/dashboard/staff", version: V } });
  expect(screen.getByText("Club sign-in account")).toBeInTheDocument();
  expect(screen.getByText("Staff account (manager)")).toBeInTheDocument();
  expect(screen.queryByText(/changed by the club in Staff settings/)).toBeNull();
  await verifyAndStart(); // ticks the call-back checkbox, fills the note, clicks the button
  expect(screen.getByRole("button", { name: "Change this staff account's login address" })).toBeEnabled();
  await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
  expect(screen.getByRole("dialog")).toHaveTextContent(/Pat will be signed out everywhere/);
});

it("posts the staff move to the staff route with the step-up header, then re-checks", async () => {
  const fetchMock = mockFetchSequence([
    { url: "/api/admin/auth/step-up", body: { ok: true, grant: "GRANT" } },
    { url: "/api/admin/customers/T/staff/u1/login-email", body: { ok: true, userId: "u1", sessionsRevoked: true, retired: 0 } },
    { url: "/api/admin/customers/T/login-email/check", body: { ok: true, free: true, tenant: { id: "T", name: "Club" }, owner: { id: "o1", name: "Owner" } } },
  ]);
  renderPanel({ holder: { kind: "user", id: "u1", name: "Pat", status: "manager", canSignIn: true, access: "password", link: "/dashboard/staff", version: V } });
  await verifyAndStart();
  await user.click(screen.getByRole("button", { name: "Change this staff account's login address" }));
  await user.type(screen.getByLabelText(/new login address/i), "pat.manager@club.test");
  await user.type(screen.getByLabelText(/reason/i), "Club confirmed by call-back");
  await user.type(screen.getByLabelText(/authenticator code/i), "123456");
  await user.click(screen.getByRole("button", { name: /^Change login address$/ }));
  const calls = fetchMock.mock.calls.map(([u, init]) => ({ u: String(u), h: new Headers((init as RequestInit)?.headers) }));
  const move = calls.find((c) => c.u.endsWith("/staff/u1/login-email"))!;
  expect(move.h.get("x-matflow-step-up")).toBe("GRANT");
  expect(calls.at(-1)!.u).toMatch(/\/login-email\/check$/);
});

it("lists every holder of a duplicate, each with its own move button, and keeps the owner step closed until free", async () => {
  renderPanel({ holder: { kind: "many", count: 2, holders: [
    { kind: "member", id: "m1", name: "A", status: "active", canSignIn: true, access: "password", link: "/m1", version: V },
    { kind: "user", id: "u1", name: "B", status: "coach", canSignIn: true, access: "password", link: "/dashboard/staff", version: V },
  ] } });
  expect(screen.getAllByRole("button", { name: /Change this (member's contact|staff account's login) address/ })).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Change the owner's login address" })).toBeNull();
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run tests/unit/conflict-panel.test.tsx`
Expected: the four new tests FAIL. The existing ones pass.

- [ ] **Step 3: Implement in `ConflictPanel.tsx`.**
  - **The "Held by" row** renders, for a single holder:

    ```tsx
    const k = describeRecordKind(holder.kind, holder.status);
    <span style={adminPill(holder.kind === "member" ? "neutral" : "amber")}>{k.badge}</span> {k.title}: <strong>{holder.name}</strong>
    <span style={{ display: "block", fontSize: 11, color: adminPalette.muted }}>{k.detail}</span>
    ```

    Then, when `sameNameNote(holder.name, current.owner.name)` is non-null, render it as a `<p role="note">` below the row.
  - **Replace the staff dead-end** with the same review step the member path uses: a verification checkbox, a verification note of at least `REASON_MIN` characters, and a button labelled "Change this staff account's login address".
    - The button opens the existing `Dialog` in a new mode, `"staff"`.
    - The dialog's first line reads `{name} will be signed out everywhere and must sign in with the new address.`. The fields are the new address, the reason and the authenticator code.
    - Submit runs the existing step-up request with action `staff.login_email` and target `${tenantId}/${holder.id}/change`, then `POST /api/admin/customers/${tenantId}/staff/${holder.id}/login-email` with `{ newEmail, reason, version }` and the grant header.
    - The response handling is the member path's: the `alreadyApplied` message, then the automatic re-check, then the owner step.
  - **Replace the `many` dead-end** with a list. Each holder gets a "Held by" row as above, plus its own button: "Change this member's contact address" for a member, or "Change this staff account's login address" for a staff account. Each opens the matching dialog for that holder.
    - After each success, re-check.
    - While the re-check still reports holders, show the list again.
    - Once the address is free, show the existing owner step.
    - The owner button never renders while `holder` is present.
  - **Resume:** keep the existing URL resume (`?resolve=owner&member=<id>`) and extend it with `&staff=<id>` for the staff path. Ids only, as now.
- [ ] **Step 4: Update `LoginEmailCard.tsx`'s heading and description** as given under Files. Run the tests:

  Run: `npx vitest run tests/unit/conflict-panel.test.tsx tests/unit/record-kind.test.ts`
  Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add components/admin/ConflictPanel.tsx "app/admin/tenants/[id]/LoginEmailCard.tsx" tests/unit/conflict-panel.test.tsx
git commit -m "feat(hub): resolve staff-account and duplicate conflicts in the panel; every holder labelled club sign-in account vs member record"
```

### Task 5: End-to-end proof on a production build, runbook, release

**Files:**
- Create: `docs/runbooks/OPERATOR-LOGIN-CONFLICTS.md`
- Test: a scratchpad Playwright driver run against a production build on TEST, using the isolated launcher (`prod-server.mjs` pattern), port 3961, behind a local https proxy. That proxy is required: the TOTP verify cookie is `__Secure-` only over https.

- [ ] **Step 1: Seed three run-stamped clubs on TEST,** one per case:
  1. a member holds the owner's target (Sean's shape, with the same name as the owner);
  2. a manager holds it;
  3. a member and a coach both hold it.
- [ ] **Step 2: Drive each case as an allow-listed TEST operator,** with the authenticator secret from the run fixture:
  - check;
  - read the labels: assert "Member record" or "Club sign-in account", and the same-name note in case 1;
  - resolve every holder;
  - change the owner;
  - the result shows "Conflict resolved".

  After each case, assert in the database that:
  - the owner has the target address;
  - each moved record has its new address;
  - nothing else changed: `passwordHash`, TOTP, role, membership rows and attendance counts are equal to a pre-snapshot;
  - the audit rows exist.
- [ ] **Step 3: Write the runbook.** It covers:
  - the three cases;
  - what each button does to which record;
  - who gets signed out;
  - why a phone call-back is required before acting;
  - how to resume after a lost response.

  Use British English and plain sentences.
- [ ] **Step 4: Run the gates:** `npm run lint && npm test && npm run build`, both integration roles, and the e2e driver. Paste results into the PR.
- [ ] **Step 5: Release.** Open a PR to `main` and compare CI with the 17 inherited failures. Then get Noe's explicit "deploy" approval, merge with a merge commit, and check live at `/admin` on Total BJJ. The check is read-only: run a check only, with no change.

```bash
git add docs/runbooks/OPERATOR-LOGIN-CONFLICTS.md
git commit -m "docs(runbook): operator login-address conflicts — the three cases, who is signed out, call-back rule"
```

---

## Verification (end to end)
- **Unit:**
  - `record-kind`;
  - the `staff.login_email` step-up;
  - the conflict panel's four new cases plus the existing ones.
- **Integration, TEST, both roles:**
  - the staff move succeeds, is idempotent on re-send, and refuses the owner, a stale version, a taken target and a managed target;
  - the check lists duplicate holders with versions.
- **Production build on TEST:** all three conflict shapes are resolved from the hub. Every record other than the intended address fields is byte-identical before and after.
- **Live after the release:** a read-only check on Total BJJ shows the new labels. No live mutation is part of verification.

## Execution
Recommended: **subagent-driven**. Tasks 3 and 4 depend on the exact field names and route path from Tasks 2 and 3. A mistake ships into an operator-only control that can sign people out, so a fresh reviewer per task is worth the cost.
