# Member authenticator codes: single use (design, 11 Nov 2026)

**Status:** design only. Not implemented. It needs an additive migration, which needs Noe's approval.

## The gap (Round 5 map #11)

A staff code is spent when it is used. `consumeUserTotp` in `lib/login-email.ts` records the accepted 30-second step in `User.totpLastUsedStep` with a conditional update, and refuses any code from that step or earlier. Operators work the same way (`Operator.totpLastUsedStep`).

A member's code is only *checked*. `Member` has no step column, so a member code is accepted again for as long as it is valid. That is the current 30-second step, plus the previous one where tolerance allows. The places that check a member code are:
- `app/api/member/totp/verify/route.ts:74`: completing a sign-in that is waiting for its second factor (`totpPending`);
- `app/api/member/totp/setup/route.ts:135`: confirming enrolment;
- `app/api/member/totp/recovery-codes/route.ts:66`: the step-up added in Round 5.

**Exposure:** someone who sees a member's code can use it once more within about 60 seconds. They might see it over the member's shoulder, from a phishing page relaying it live, or from a captured request. To complete a sign-in they also need the member's password. With an already-stolen session, they can replace the member's recovery codes.

Severity is **Low**: it needs the code within its window, as well as the password or a stolen session.

## Design

### Schema (additive, one migration)

```sql
-- prisma/migrations/<stamp>_member_totp_last_used_step/migration.sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "Member" ADD COLUMN "totpLastUsedStep" INTEGER;
COMMIT;
```

- **The column is nullable with no default, so adding it is a catalogue change only.** It does not rewrite the table (Postgres 11 and later). It holds an ACCESS EXCLUSIVE lock for milliseconds, and `lock_timeout` makes it fail fast instead of queueing behind long transactions.
- **This follows `docs/readiness/MIGRATION-SAFETY-2026-10-24.md`.**
- **There is no backfill:** `NULL` means no step has been spent yet.
- **The schema line is** `totpLastUsedStep Int?` on `Member`, beside `totpSecret`.
- **Imports, exports and erasure:** the column is not personal data. The DSAR export and erasure leave it alone; erasure already clears `totpSecret` and `totpEnabled`.

### One function, used everywhere a member code is accepted

Add `consumeMemberTotp(tx, member, code)` to `lib/login-email.ts`, next to `consumeUserTotp`. It does the same job:

```ts
export async function consumeMemberTotp(
  tx: Prisma.TransactionClient,
  member: { id: string; tenantId: string; totpSecret: string; totpLastUsedStep: number | null },
  code: string,
  opts: { allowPreviousStep?: boolean } = {},
): Promise<boolean> {
  if (!/^\d{6}$/.test(code)) return false;
  const result = verifySync({
    token: code,
    secret: member.totpSecret,
    ...(opts.allowPreviousStep ? { epochTolerance: [30, 0] as [number, number] } : {}),
    ...(member.totpLastUsedStep !== null ? { afterTimeStep: member.totpLastUsedStep } : {}),
  });
  if (!result.valid) return false;
  const step = (result as { timeStep?: number }).timeStep;
  if (typeof step !== "number" || !Number.isSafeInteger(step)) return false;
  const spent = await tx.member.updateMany({
    where: { id: member.id, tenantId: member.tenantId, OR: [{ totpLastUsedStep: null }, { totpLastUsedStep: { lt: step } }] },
    data: { totpLastUsedStep: step },
  });
  return spent.count === 1;
}
```

**Atomicity and concurrency.**
- **Two requests with the same code:** both may pass `verifySync`, which is a pure check, but only one wins.
  - The `updateMany` is a single `UPDATE … WHERE totpLastUsedStep IS NULL OR totpLastUsedStep < step`.
  - Postgres row-locks the member row for the first request.
  - The second waits. When the lock frees, it re-evaluates the `WHERE` against the committed row (READ COMMITTED re-check), matches nothing, and gets `count 0`.
- **A later code still works:** a code from a later step is still accepted (`step > last`).
- **Codes from the same step:** a code from the same step, or an earlier one, is refused even when it is a different code in a tolerance window.
- **No extra lock:** the conditional update is the lock. Staff use the same pattern (`consumeUserTotp`) and the operator plane does too. There is no new lock-order level: a single-row `UPDATE` on Member is lock-order level 3 (`docs/design/LOCK-ORDER-2026-10-24.md`), the same level as every other member write.

### Call sites

| Where | Today | After |
|---|---|---|
| `member/totp/verify` (sign-in second factor) | `verifySync` | `consumeMemberTotp` inside `withTenantContext`. A refusal reads "Invalid code". The response does not say "already used", so it doesn't tell an attacker anything. |
| `member/totp/setup` POST (confirm enrolment) | `verifySync` | `consumeMemberTotp`. Enabling, issuing the recovery codes (Round 5, L-5) and spending the code all happen in one write. |
| `member/totp/recovery-codes` (step-up, Round 5) | `verifySync` with the previous step allowed | `consumeMemberTotp(…, { allowPreviousStep: true })` |
| Member email change, if decision 1 adopts a step-up | n/a | `consumeMemberTotp` |

### Enrolment and reset

**New secret:** every place that sets a new `totpSecret` or clears it also sets `totpLastUsedStep = NULL` in the same write. Steps spent under the old secret mean nothing for a new one. That covers:
- `member/totp/setup` GET (a new secret while not yet enabled);
- staff reset `members/[id]/totp-reset`;
- operator reset `admin/customers/[id]/member-totp-reset`;
- self-service recovery `member/totp/recover`;
- DSAR erasure.

**Enrolment:** the code that confirms enrolment is spent. The recovery codes are issued in that same write, so there is no second request that would need to reuse the code. This is why Round 5 L-5 moved code issuing into setup.

**Magic link:** the magic link still skips the member's second factor. That is documented design (`magic-link/verify/route.ts:293`) and is out of scope here; it is listed with decision 1.

### Tests that would prove it (Neon test branch, both roles)

1. **Replay:** a code accepted at sign-in is refused when sent again, in the same and the next request.
2. **Concurrency:** two simultaneous sign-in completions with one code give exactly one 200.
3. **Later code:** a code from the next step is accepted after one has been spent.
4. **Enrolment spends its code:** the same code then fails at `member/totp/verify`.
5. **Staff reset clears the step:** after a staff reset and re-enrolment, a code from the new secret is accepted even though its step number is lower than the old spent step.
6. **Recovery-codes step-up spends:** replaying the code to the recovery-codes route is refused.
7. **Migration on a scratch database:** `migrate-test.mjs` with `MF_MIGRATE_TEST_DB` on the direct host, timing and locks recorded as in the migration-safety record.

### Release

- **Deploy order:** the migration ships with the code. A Vercel production build runs `prisma migrate deploy` before `next build`, so the column exists before the new code serves.
- **Old code:** it ignores the column, so a failed deploy leaves nothing inconsistent.
- **Recovery:** fix forward. The column is harmless if unused. Never Instant Rollback.
- **Effort:** about half a day including tests.
- **Needs:** Noe's approval of the migration.
