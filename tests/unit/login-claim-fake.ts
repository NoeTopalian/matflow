// Unit-test fake for the login-identity claim SQL (lib/login-email.ts,
// admin hub AH-01, 9 Oct 2026).
// Not a test file (no .test suffix): imported by route unit tests.
//
// claimLoginIdentity / claimLoginIdentities take a transaction-scoped
// advisory lock (`$executeRaw`) and look the holders up with two `$queryRaw`
// reads (one on "User", one on "Member"). Route unit tests run against an
// in-memory fake transaction, so this adds those two methods to the fake and
// answers the reads from the fake's OWN tables — through `findFirst`/`findMany`
// on `{ tenantId, email }`, exactly the rows the 7-Oct collision checks read —
// so a test's existing collision set-up still decides the outcome.
//
// `locks` records every lock key taken, in order, for assertions.

type Row = Record<string, unknown>;
type Finder = {
  findFirst?: (args: { where: Row; select?: Row }) => Promise<Row | null>;
  findMany?: (args: { where: Row; select?: Row }) => Promise<Row[]>;
};

async function rowsOf(table: Finder | undefined, tenantId: string, email: string): Promise<Row[]> {
  if (!table) return [];
  // findFirst, as the 7-Oct checks did (a test's mocks are keyed to it); the
  // inconsistent-many case is covered against a real database instead.
  // A fake that ignores the email filter must not make every row a holder:
  // a returned row that carries an address is kept only when it matches.
  const where = { tenantId, email };
  const same = (r: Row) => typeof r.email !== "string" || r.email.trim().toLowerCase() === email;
  if (table.findFirst) {
    const r = await table.findFirst({ where });
    return r && same(r) ? [r] : [];
  }
  if (table.findMany) {
    const r = await table.findMany({ where });
    if (Array.isArray(r)) return r.filter(same);
  }
  return [];
}

/**
 * `holders` overrides where the holder reads come from — for a test whose
 * `member.findFirst` mock is scripted for other reads (pass `{}` for "nobody
 * holds anything").
 */
export function addLoginClaimSql<T extends object>(
  tx: T,
  holders?: { user?: Finder; member?: Finder },
): T & ClaimSql {
  const locks: number[][] = [];
  const t = (holders ?? tx) as { user?: Finder; member?: Finder };
  const ext = {
    locks,
    $executeRaw: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? (strings as TemplateStringsArray).join("?") : String(strings);
      if (sql.includes("pg_advisory_xact_lock")) locks.push(values.map((v) => Number(v)));
      return 1;
    },
    $queryRaw: async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? (strings as TemplateStringsArray).join("?") : String(strings);
      // lib/migration-lock.ts holdOffMigrations: no schema migration ever runs in the fake database.
      if (sql.includes("pg_try_advisory_xact_lock_shared")) return [{ ok: true }];
      const [tenantId, emails] = values as [string, string[]];
      const isUser = /FROM "User"/.test(sql);
      const isMember = /FROM "Member"/.test(sql);
      if (!isUser && !isMember) return [];
      const out: Row[] = [];
      for (const email of emails ?? []) {
        for (const r of await rowsOf(isUser ? t.user : t.member, tenantId, email)) {
          const stored = typeof r.email === "string" ? r.email : email;
          out.push(
            isUser
              ? { id: r.id, name: r.name ?? "", role: r.role ?? "coach", key: email }
              : { id: r.id, name: r.name ?? "", status: r.status ?? "active", hasPassword: r.passwordHash != null, email: stored, key: email },
          );
        }
      }
      return out;
    },
  };
  return Object.assign(tx, ext) as T & ClaimSql;
}

type ClaimSql = {
  $executeRaw: (...a: unknown[]) => Promise<number>;
  $queryRaw: (...a: unknown[]) => Promise<Row[]>;
  locks: number[][];
};
