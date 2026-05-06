// One-off TOTP reset for noetopalian@gmail.com.
// Run from matflow root: node scripts/reset-totp-noe.mjs
// Reads .env directly. Bumps sessionVersion to invalidate every existing JWT.

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const envPath = path.resolve('.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL not set'); process.exit(1); }
const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

const email = 'noetopalian@gmail.com';

const before = await prisma.user.findFirst({
  where: { email },
  select: { id: true, email: true, role: true, tenantId: true, totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, sessionVersion: true },
});

if (!before) { console.log(`No user found with email ${email}.`); await prisma.$disconnect(); process.exit(0); }

console.log('BEFORE:', {
  totpEnabled: before.totpEnabled, hasSecret: before.totpSecret !== null,
  recoveryCount: (before.totpRecoveryCodes || []).length, sessionVersion: before.sessionVersion,
});

const result = await prisma.user.update({
  where: { id: before.id },
  data: {
    totpEnabled: false,
    totpSecret: null,
    totpRecoveryCodes: [],
    sessionVersion: { increment: 1 },
  },
  select: { totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, sessionVersion: true },
});

console.log('AFTER:', {
  totpEnabled: result.totpEnabled, hasSecret: result.totpSecret !== null,
  recoveryCount: (result.totpRecoveryCodes || []).length, sessionVersion: result.sessionVersion,
});

console.log('TOTP cleared + sessionVersion bumped. All existing JWTs are now invalid.');
console.log('Sign in again — you will get a fresh token with totpPending=false and requireTotpSetup=true.');
await prisma.$disconnect();
