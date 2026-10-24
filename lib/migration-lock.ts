// Coordination between schema migrations and the club's bulk data jobs (brief S2.3, 24 Oct 2026).
//
// `prisma migrate deploy` (scripts/maybe-migrate.mjs, every production build) serialises itself on ONE Postgres
// advisory lock: the schema engine runs `SELECT pg_advisory_lock(72707369)` on its own session before it reads
// `_prisma_migrations` and holds it until it has finished (key and behaviour verified by experiment on Prisma 7.10.0 —
// in pg_locks it is the single-bigint advisory lock classid 0, objid 72707369, objsubid 1, mode ExclusiveLock — see
// docs/readiness/MIGRATION-SAFETY-2026-10-24.md). The bulk jobs that rewrite a club's members, standing and history —
// the TeamUp import commit, status refresh and rollback, the attendance import's start, steps and rollback, and the
// status back-fill — take the SHARED form of the same key at the start of each of their write transactions, without
// waiting:
//   - while a migration holds the key, or is queued for it, the job's transaction is refused at once with
//     MigrationInProgressError (nothing written); the job says "a database update is being applied — try again in a few
//     minutes" and, because every job here is resumable, carries on from its last saved point when run again;
//   - while a job's transaction holds the shared key, the migration waits for it (Prisma waits up to 10 s, then fails
//     the deploy with P1002, which fails the build: nothing migrates and the deploy is simply retried).
// Shared, so jobs never block each other; transaction-scoped (`_xact_`), so it is released by COMMIT or ROLLBACK and
// works through the pgbouncer transaction-mode pooler the app connects through.
//
// What this does NOT do: it does not cover the gap BETWEEN two of a job's transactions (a migration may run there; every
// migration of this release is expand-only, so the job's next transaction still works), and it only works if the
// migration's session is a real session — `prisma migrate deploy` must run on the DIRECT (non-pooler) host, see the
// migration matrix in the safety record.
import type { Prisma } from "@prisma/client";

/** Prisma Migrate's Postgres advisory lock key (schema engine 7.x). Single bigint form. */
export const PRISMA_MIGRATE_ADVISORY_LOCK_KEY = 72707369;

export const MIGRATION_IN_PROGRESS_MESSAGE =
  "A database update is being applied right now. Nothing was changed — try again in a few minutes; the import carries on from where it stopped.";

/** Refused because a schema migration holds (or is queued for) Prisma Migrate's advisory lock. Nothing was written. */
export class MigrationInProgressError extends Error {
  readonly code = "MIGRATION_IN_PROGRESS";
  readonly status = 503;
  readonly retryAfterSeconds = 120;
  constructor() {
    super(MIGRATION_IN_PROGRESS_MESSAGE);
    this.name = "MigrationInProgressError";
  }
}

type RawTx = Pick<Prisma.TransactionClient, "$queryRaw">;

/**
 * Inside a transaction: take the shared form of Prisma Migrate's advisory lock without waiting, held until the
 * transaction ends; throws MigrationInProgressError when a migration holds or awaits it. Call it FIRST in the
 * transaction, before any write.
 */
export async function holdOffMigrations(tx: RawTx): Promise<void> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`SELECT pg_try_advisory_xact_lock_shared(${PRISMA_MIGRATE_ADVISORY_LOCK_KEY}::bigint) AS ok`;
  if (rows[0]?.ok !== true) throw new MigrationInProgressError();
}

export function isMigrationInProgress(e: unknown): e is MigrationInProgressError {
  return e instanceof MigrationInProgressError || (typeof e === "object" && e !== null && (e as { code?: unknown }).code === "MIGRATION_IN_PROGRESS");
}
