/**
 * Which accounts the email backfill could NOT normalise, and why.
 *
 * `prisma/migrations/20260913230000_lowercase_emails` lowercases addresses so
 * they match how every recovery path already reads them — but only where doing
 * so cannot violate `@@unique([tenantId, email])`. A migration that violates it
 * does not fail one deploy: the failed row in `_prisma_migrations` aborts every
 * later `migrate deploy`, including the one that would revert it, and the only
 * unblocking command must be run against production from a laptop.
 *
 * So anything that would have collided was deliberately left alone. Each one is
 * two accounts in one club whose addresses differ only by case — a real
 * duplicate needing a human decision about which is the live account. Silently
 * merging them in a migration would be data loss.
 *
 * Run:
 *   npx tsx scripts/report-email-collisions.ts
 *
 * Reads only. Refuses nothing, changes nothing, prints what it finds.
 */
import { prisma } from "../lib/prisma";

type Row = { tenantId: string; normalised: string; ids: string[]; spellings: string[] };

async function collisions(table: "User" | "Member"): Promise<Row[]> {
  // Grouped on the NORMALISED address, so both shapes surface: a mixed-case row
  // against an existing lowercase twin, and two mixed-case rows that would
  // collide with each other.
  return prisma.$queryRawUnsafe<Row[]>(`
    SELECT "tenantId",
           lower(btrim("email")) AS normalised,
           array_agg("id"    ORDER BY "id")    AS ids,
           array_agg("email" ORDER BY "id")    AS spellings
    FROM "${table}"
    WHERE "email" IS NOT NULL
    GROUP BY "tenantId", lower(btrim("email"))
    HAVING count(*) > 1
    ORDER BY "tenantId"
  `);
}

async function main() {
  let total = 0;
  for (const table of ["User", "Member"] as const) {
    const rows = await collisions(table);
    total += rows.length;
    if (rows.length === 0) {
      console.log(`${table}: no case-collisions — every address normalised cleanly.`);
      continue;
    }
    console.log(`\n${table}: ${rows.length} address(es) held by more than one row in a club.`);
    for (const r of rows) {
      console.log(`  tenant ${r.tenantId}  ${r.normalised}`);
      r.ids.forEach((id, i) => console.log(`    ${id}  ${r.spellings[i]}`));
    }
  }

  if (total === 0) {
    console.log("\nNothing to decide.");
  } else {
    console.log(
      `\n${total} case-collision(s) left as they are, deliberately.\n` +
      "Each is two accounts in one club differing only by case. Decide which is\n" +
      "the live one and remove or re-address the other; until then, the non-\n" +
      "lowercase row cannot recover its password or use a magic link.",
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
