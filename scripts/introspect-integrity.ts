// One-off integrity probe against the *test branch*. Prints the CHECK
// constraints, unique constraints, and RLS state actually present in the DB,
// so the Layer-5 integrity meta-test can assert against ground truth.
// Host-guarded — refuses production.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
// This script is strictly read-only (SELECTs against pg_catalog). It refuses
// prod by default; an explicit ALLOW_PROD_READONLY=1 opt-in permits a
// read-only posture probe against production.
if (url.includes("ep-bold-wave") && process.env.ALLOW_PROD_READONLY !== "1") {
  throw new Error("Refusing prod without ALLOW_PROD_READONLY=1 (read-only probe opt-in)");
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const checks = await prisma.$queryRawUnsafe<{ table: string; name: string; def: string }[]>(
    `SELECT rel.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE con.contype = 'c' AND ns.nspname = 'public'
     ORDER BY rel.relname, con.conname;`,
  );
  console.log("\n=== CHECK constraints ===");
  for (const c of checks) console.log(`${c.table}.${c.name}: ${c.def}`);

  const uniques = await prisma.$queryRawUnsafe<{ table: string; name: string; def: string }[]>(
    `SELECT rel.relname AS table, con.conname AS name, pg_get_constraintdef(con.oid) AS def
     FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE con.contype = 'u' AND ns.nspname = 'public'
     ORDER BY rel.relname;`,
  );
  console.log("\n=== UNIQUE constraints ===");
  for (const u of uniques) console.log(`${u.table}.${u.name}: ${u.def}`);

  const rls = await prisma.$queryRawUnsafe<{ table: string; rls: boolean; forced: boolean; policies: number }[]>(
    `SELECT rel.relname AS table, rel.relrowsecurity AS rls, rel.relforcerowsecurity AS forced,
            (SELECT count(*) FROM pg_policy p WHERE p.polrelid = rel.oid)::int AS policies
     FROM pg_class rel JOIN pg_namespace ns ON ns.oid = rel.relnamespace
     WHERE ns.nspname = 'public' AND rel.relkind = 'r'
       AND rel.relname IN ('Member','User','Payment','Order','Attendance','ClassInstance','MembershipTier','Tenant')
     ORDER BY rel.relname;`,
  );
  console.log("\n=== RLS state (key tables) ===");
  for (const r of rls) console.log(`${r.table}: rls=${r.rls} forced=${r.forced} policies=${r.policies}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
