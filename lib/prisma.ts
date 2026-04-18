import { PrismaClient } from "@prisma/client";

const isSQLite = process.env.DATABASE_URL?.startsWith("file:");

function createPrismaClient() {
  if (isSQLite) {
    // Local SQLite for development
    const Database = require("better-sqlite3");
    const { PrismaBetterSqlite3 } = require("@prisma/adapter-better-sqlite3");
    const dbPath = process.env.DATABASE_URL!.replace("file:", "").replace("./", "");
    const sqlite = new Database(require("path").join(process.cwd(), dbPath));
    const adapter = new PrismaBetterSqlite3(sqlite);
    return new PrismaClient({ adapter });
  }

  // PostgreSQL for production (Supabase / Vercel Postgres)
  const { PrismaPg } = require("@prisma/adapter-pg");
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
