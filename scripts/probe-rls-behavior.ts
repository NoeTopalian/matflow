// Decisive RLS probe: does the connecting role actually get RLS enforcement?
// Prints role privileges + a behavioural default-deny check. Host-guarded.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
if (url.includes("ep-bold-wave") && process.env.ALLOW_PROD_READONLY !== "1") {
  throw new Error("Refusing prod without ALLOW_PROD_READONLY=1");
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const role = await prisma.$queryRawUnsafe<{ user: string; super: boolean; bypassrls: boolean }[]>(
    `SELECT current_user AS user, r.rolsuper AS super, r.rolbypassrls AS bypassrls
     FROM pg_roles r WHERE r.rolname = current_user;`,
  );
  console.log("ROLE:", JSON.stringify(role[0]));

  if (process.env.ROLE_ONLY === "1") return; // prod: role attributes only, no data reads

  const diag = await prisma.$queryRawUnsafe<{ rls: boolean; forced: boolean; bypass: string | null; tenant: string | null; pol: number }[]>(
    `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
            current_setting('app.bypass_rls', true) AS bypass,
            current_setting('app.current_tenant_id', true) AS tenant,
            (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS pol
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='Member';`,
  );
  console.log("DIAG Member:", JSON.stringify(diag[0]));
  // Behavioural default-deny: query Member with NO tenant context set.
  // Proper FORCE RLS + non-bypass role + tenant policy => 0 rows.
  const noCtx = await prisma.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "Member";`);
  console.log("Member count WITHOUT tenant context:", Number(noCtx[0].n), "(0 => RLS denies; >0 => role bypasses RLS)");
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
