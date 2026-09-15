/**
 * One-off: clear the 2FA verification (TOTP) on the demo member Reese so
 * sign-in stops demanding a verification code. Mirrors the staff endpoint
 * app/api/members/[id]/totp-reset (totpEnabled=false, secret + recovery
 * codes cleared, sessionVersion bumped) — but also actually nulls the
 * recovery codes, which the endpoint's `undefined` write skips.
 *
 * Run:            node scripts/reset-reese-totp.mjs          (inspect only)
 * Apply the reset: node scripts/reset-reese-totp.mjs --apply
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const apply = process.argv.includes("--apply");

async function main() {
  const reese = await prisma.member.findFirst({
    where: {
      OR: [
        { name: { contains: "Reese", mode: "insensitive" } },
        { email: { contains: "reese", mode: "insensitive" } },
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      tenantId: true,
      totpEnabled: true,
      totpSecret: true,
      totpRecoveryCodes: true,
      passwordHash: true,
      sessionVersion: true,
      tenant: { select: { slug: true, name: true } },
    },
  });

  if (!reese) {
    console.log("No member matching 'Reese' found.");
    return;
  }

  console.log("Member:", reese.id, "-", reese.name, `<${reese.email}>`, "tenant:", reese.tenant?.slug);
  console.log("  totpEnabled:      ", reese.totpEnabled);
  console.log("  totpSecret:       ", reese.totpSecret ? "set" : "null");
  console.log("  totpRecoveryCodes:", reese.totpRecoveryCodes ? "set" : "null");
  console.log("  passwordHash:     ", reese.passwordHash ? "set" : "null");
  console.log("  sessionVersion:   ", reese.sessionVersion);

  if (!apply) {
    console.log("\nInspect only — rerun with --apply to clear TOTP.");
    return;
  }

  await prisma.member.update({
    where: { id: reese.id },
    data: {
      totpEnabled: false,
      totpSecret: null,
      totpRecoveryCodes: null,
      sessionVersion: { increment: 1 },
    },
  });
  console.log("\nTOTP cleared. Reese signs in with password only and can re-enrol from the profile page.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
