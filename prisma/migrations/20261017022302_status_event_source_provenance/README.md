# 20261017022302_status_event_source_provenance — lock note

**Correction to a comment in `migration.sql` (review F5, 23 Oct 2026).** The SQL is safe. The comment is corrected here rather than in the file, because editing any line of a migration file, comments included, changes its checksum.

**26 Oct 2026 (release integration):** the file did gain one block, the bounded-wait header every migration from `20261017020102` on carries (`SET LOCAL lock_timeout = '5s'` and `statement_timeout = '15s'` after `BEGIN`; `tests/unit/migrations-bounded-waits.test.ts`). The statements are unchanged. The file has never been applied in production; the test branch's recorded checksum is re-stamped with `scripts/readiness/test-branch-restamp-migrations.mjs`, as for the six plan-limit migrations on 24 Oct.

## What the comment says, and why it is wrong

Above the CHECK constraint, `migration.sql` says that adding it `NOT VALID` and then running `VALIDATE CONSTRAINT` adds the constraint "without a full-table check under the ALTER's lock, then checked".

That is not what happens here. The whole migration runs inside one `BEGIN … COMMIT`. The first statement, `ALTER TABLE "MemberStatusEvent" ADD COLUMN …`, takes an `ACCESS EXCLUSIVE` lock on the table, and Postgres holds every lock until the transaction ends. So:

- `VALIDATE CONSTRAINT` runs while the `ACCESS EXCLUSIVE` lock is still held. Its lighter lock (`SHARE UPDATE EXCLUSIVE`) gains nothing.
- The non-concurrent `CREATE INDEX` also runs under that same lock.

Splitting `NOT VALID` from `VALIDATE` only lowers locking when the two run in **separate** transactions, with the `VALIDATE` committed on its own after the `ADD CONSTRAINT … NOT VALID` has committed.

## Why it does not matter for this migration

- `MemberStatusEvent` is small (one row per status change per member; a club's whole history is a few thousand rows at most as of October 2026).
- Both new columns are nullable with no default, so `ADD COLUMN` changes only the catalogue and rewrites no rows.
- Every existing row is null in `sourceAction`, so the CHECK passes at once.
- The lock is held for milliseconds. The build that is live while this runs is unaffected: its Prisma client never names the new columns, the CHECK admits null, and there is no foreign key.

## Do not copy the pattern as written

A later migration on a large table must not copy this file's `NOT VALID` / `VALIDATE` pair expecting it to be lock-light inside one transaction. To keep a constraint check off the exclusive lock, add the constraint `NOT VALID` in one migration and `VALIDATE` it in a later, separate one, or check that the table is small enough for the lock to be harmless, as it is here.
