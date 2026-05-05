import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const rlsTables = await prisma.$queryRaw`
  SELECT c.relname AS tablename, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
  ORDER BY c.relname
`;
console.log(`RLS-enabled tables: ${rlsTables.length}`);
for (const t of rlsTables) console.log(`  ${t.tablename} (force=${t.forced})`);

const lockoutCols = await prisma.$queryRaw`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_name IN ('User', 'Member') AND column_name IN ('failedLoginCount','lockedUntil')
  ORDER BY table_name, column_name
`;
console.log(`\nLockout columns: ${lockoutCols.length}`);
for (const c of lockoutCols) console.log(`  ${c.table_name}.${c.column_name}`);

await prisma.$disconnect();
