// Create a restricted, non-BYPASSRLS application role on the *test branch* so
// RLS actually enforces (proves the prod remediation). Run as the owner.
// Host-guarded — refuses production.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const url = process.env.DATABASE_URL ?? "";
if (url.includes("ep-bold-wave")) throw new Error("Refusing prod — create the role manually on prod when you cut over");
if (!url.includes("ep-hidden-salad")) throw new Error("Not the known test-branch host; aborting");

const ROLE = "matflow_app";
const PW = process.env.RESTRICTED_ROLE_PW;
if (!PW) {
  console.error("RESTRICTED_ROLE_PW env var required (audit C-1: the previous hardcoded fallback was a leaked credential).");
  process.exit(1);
}
// Audit C-1 follow-up: PW is string-interpolated into a SQL literal below
// via `$executeRawUnsafe`. Reject any character that could break out of the
// string (single quote, backslash) — a malicious env var would otherwise inject
// arbitrary SQL with role-creation privileges.
// Audit iter-2 M2-2: ALSO reject `$` so a password containing `$$` cannot
// prematurely terminate the outer `DO $role_create$ ... $role_create$` block
// even if the dollar-quote tag is uniqued (defence-in-depth — the unique tag
// alone is sufficient, but blocking $ removes the attack surface entirely).
if (!/^[A-Za-z0-9_\-+!@#%^&*=.]{8,}$/.test(PW)) {
  console.error("RESTRICTED_ROLE_PW must match [A-Za-z0-9_\\-+!@#%^&*=.]{8,} (no quotes, no backslashes, no $) to be SQL-safe.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  const stmts = [
    // CREATE ROLE defaults to NOBYPASSRLS NOSUPERUSER — exactly what we want.
    // (Neon's owner role lacks privilege to ALTER ROLE attributes, and it's
    // unnecessary here.)
    // Audit iter-2 M2-2: use a unique dollar-quote tag (`$role_create$`) so
    // a `$$` sequence in PW cannot terminate the outer block. Combined with
    // the regex above (which also blocks `$`) this is defence-in-depth.
    `DO $role_create$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${PW}'; END IF; END $role_create$;`,
    `GRANT USAGE ON SCHEMA public TO ${ROLE};`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE};`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE};`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLE};`,
  ];
  for (const s of stmts) { await prisma.$executeRawUnsafe(s); }

  const chk = await prisma.$queryRawUnsafe<{ rolbypassrls: boolean; rolsuper: boolean }[]>(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname='${ROLE}';`,
  );
  console.log(`role ${ROLE} created; bypassrls=${chk[0].rolbypassrls} super=${chk[0].rolsuper} (both must be false)`);
}

main().catch((e) => { console.error("ERR", e.message); process.exit(1); }).finally(() => prisma.$disconnect());
