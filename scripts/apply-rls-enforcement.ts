// Bring the *test branch* up to prod parity by applying the ENABLE+FORCE RLS
// statements from 20260503200000_activate_rls_enforcement (idempotent).
// Host-guarded — refuses production (prod already has it applied).
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import fs from "fs";
import path from "path";
import { vetTestUrl } from "./readiness/rls-test-target.mjs";

// Positive allowlist on the target pg would actually reach (see scripts/readiness/rls-test-target.mjs); the old
// substring checks on the raw URL were bypassable (SF-62 / lane B, iteration 2).
const prisma = new PrismaClient({ adapter: new PrismaPg(vetTestUrl(process.env.DATABASE_URL ?? "")) });

async function main() {
  const sql = fs.readFileSync(
    path.join("prisma", "migrations", "20260503200000_activate_rls_enforcement", "migration.sql"),
    "utf8",
  );
  const statements = sql
    .split(";")
    .map((s) => s.replace(/--.*$/gm, "").trim())
    .filter((s) => s.length > 0 && /alter table/i.test(s));

  let applied = 0;
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
    applied++;
  }
  console.log(`applied ${applied} RLS ENABLE/FORCE statements`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
