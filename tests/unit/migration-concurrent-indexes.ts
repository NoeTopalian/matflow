// Migrations that build ONE index with CREATE INDEX CONCURRENTLY, and are
// therefore exempt from the BEGIN/COMMIT wrapper (migrations-are-atomic) and
// the SET LOCAL timeouts (migrations-bounded-waits): CONCURRENTLY cannot run
// inside a transaction block. Each must hold exactly one statement, of exactly
// the shape `isConcurrentIndexOnly` accepts — pinned by both tests.
//
// Add a migration here only for an index on a table too large, or too hot, to
// lock for the length of a build. Everything else uses the wrapper.
export const CONCURRENT_INDEX_MIGRATIONS = new Set<string>([
  "20261106140100_audit_log_entity_index",
]);

/** Comment-free, non-empty lines of a migration.sql. */
export function sqlLines(sql: string): string[] {
  return sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, "").trim())
    .filter(Boolean);
}

/**
 * Exactly one statement: a non-unique CREATE INDEX CONCURRENTLY with a quoted
 * name, on one quoted table — no IF NOT EXISTS (it would accept an INVALID
 * index left by a failed build), nothing else in the file.
 */
export function isConcurrentIndexOnly(sql: string): boolean {
  const lines = sqlLines(sql);
  return (
    lines.length === 1 &&
    /^CREATE INDEX CONCURRENTLY "[A-Za-z0-9_]+" ON "[A-Za-z0-9_]+"\("[A-Za-z0-9_]+"(, "[A-Za-z0-9_]+")*\);$/.test(lines[0])
  );
}
