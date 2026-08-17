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

// Storage-audit migration assertions (2026-08-16): waiver retention FK + hot-path
// indexes. confdeltype 'n' = ON DELETE SET NULL; 'r' would mean RESTRICT (pre-fix).
const waiverCol = await prisma.$queryRaw`
  SELECT is_nullable FROM information_schema.columns
  WHERE table_name = 'SignedWaiver' AND column_name = 'memberId'
`;
// confdeltype is the single-byte "char" type — cast to text or the pg
// driver adapter fails with UnsupportedNativeDataType.
const waiverFk = await prisma.$queryRaw`
  SELECT confdeltype::text AS confdeltype FROM pg_constraint
  WHERE conname = 'SignedWaiver_memberId_fkey'
`;
const hotIndexes = await prisma.$queryRaw`
  SELECT indexname FROM pg_indexes
  WHERE indexname IN ('AttendanceRecord_classInstanceId_idx', 'Payment_stripeChargeId_idx')
  ORDER BY indexname
`;
const nullable = waiverCol[0]?.is_nullable === "YES";
const setNull = waiverFk[0]?.confdeltype === "n";
console.log(`\nStorage-audit migrations:`);
console.log(`  SignedWaiver.memberId nullable: ${nullable ? "OK" : "MISSING"}`);
console.log(`  SignedWaiver_memberId_fkey ON DELETE SET NULL: ${setNull ? "OK" : "MISSING"}`);
console.log(`  Hot-path indexes present: ${hotIndexes.length}/2`);
for (const i of hotIndexes) console.log(`    ${i.indexname}`);
if (!nullable || !setNull || hotIndexes.length !== 2) {
  console.error("FAIL: storage-audit migrations not fully applied to this database.");
  process.exitCode = 1;
}

await prisma.$disconnect();
