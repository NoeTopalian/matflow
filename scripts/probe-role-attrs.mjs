// Diagnostic: why is RLS not enforcing? Check the connection role's
// attributes — especially BYPASSRLS — and the table's RLS state.

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

console.log("=== Role attributes ===");
const role = await prisma.$queryRaw`
  SELECT current_user AS role,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser
`;
console.log(role[0]);

console.log("\n=== Member table RLS state ===");
const tableState = await prisma.$queryRaw`
  SELECT relname,
         relrowsecurity AS rls_enabled,
         relforcerowsecurity AS rls_forced,
         (SELECT pg_get_userbyid(relowner)) AS owner
  FROM pg_class
  WHERE relname = 'Member' AND relkind = 'r'
`;
console.log(tableState[0]);

console.log("\n=== Member RLS policies ===");
const policies = await prisma.$queryRaw`
  SELECT polname, polpermissive, polroles, pg_get_expr(polqual, polrelid) AS using_clause
  FROM pg_policy
  WHERE polrelid = '"Member"'::regclass
`;
console.log(policies);

console.log("\n=== Verdict ===");
if (role[0].bypassrls) {
  console.log("⚠️  Connection role has BYPASSRLS — that's why policies don't apply.");
  console.log("    Fix: revoke BYPASSRLS, or use a non-privileged role for the app.");
}
if (role[0].superuser) {
  console.log("⚠️  Connection role is superuser — RLS doesn't apply unless FORCED.");
}

await prisma.$disconnect();
