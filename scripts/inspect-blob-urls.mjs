// One-off read-only diagnostic: inspect blob URLs already stored in prod, to
// learn the real Vercel Blob URL format + whether recent uploads succeeded.
// Throwaway — delete after the upload bug is fixed.
//   node scripts/inspect-blob-urls.mjs
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import "dotenv/config";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function host(u) {
  try { return new URL(u).host; } catch { return u?.slice(0, 40); }
}

const logos = await prisma.$queryRaw`
  SELECT id, name, "logoUrl" FROM "Tenant"
  WHERE "logoUrl" IS NOT NULL AND "logoUrl" <> '' LIMIT 10`;
console.log(`\n=== Tenant.logoUrl (${logos.length}) ===`);
for (const t of logos) console.log(`  ${t.name}: host=${host(t.logoUrl)}  ${String(t.logoUrl).slice(0, 90)}`);

const photos = await prisma.$queryRaw`
  SELECT id, kind, url, "uploadedAt" FROM "MemberPhoto"
  ORDER BY "uploadedAt" DESC LIMIT 12`;
console.log(`\n=== MemberPhoto.url latest (${photos.length}) ===`);
for (const p of photos) {
  const kind = p.url?.startsWith("data:") ? "data:URL" : host(p.url);
  console.log(`  ${p.uploadedAt?.toISOString?.() ?? p.uploadedAt} kind=${p.kind} host=${kind}`);
}

const audits = await prisma.$queryRaw`
  SELECT action, "createdAt", metadata FROM "AuditLog"
  WHERE action LIKE 'upload%' OR action LIKE 'member.profile_picture%'
  ORDER BY "createdAt" DESC LIMIT 12`;
console.log(`\n=== AuditLog upload actions (${audits.length}) ===`);
for (const a of audits) {
  const url = a.metadata?.url;
  console.log(`  ${a.createdAt?.toISOString?.() ?? a.createdAt} ${a.action} host=${url ? host(url) : "(no url)"}`);
}

await prisma.$disconnect();
console.log("\nDone.");
