// Seeds (or upserts) the Operator account for noetopalian@gmail.com on the
// connected DB. Set OPERATOR_PASSWORD to avoid printing a generated password.
//
// Run from matflow root: node scripts/seed-operator-noe.mjs

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
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

const EMAIL = 'noetopalian@gmail.com';
const NAME = 'Noe';

// 24 url-safe chars (~144 bits entropy) when OPERATOR_PASSWORD is not supplied.
const providedPassword = process.env.OPERATOR_PASSWORD;
if (providedPassword !== undefined && providedPassword.length < 12) {
  console.error('OPERATOR_PASSWORD must be at least 12 characters.');
  await prisma.$disconnect();
  process.exit(1);
}
const generatedPassword = providedPassword === undefined;
const password = providedPassword ?? randomBytes(18).toString('base64').replace(/[+/=]/g, '').slice(0, 24);
const passwordHash = await bcrypt.hash(password, 12);

const op = await prisma.operator.upsert({
  where: { email: EMAIL },
  update: { passwordHash, failedLoginCount: 0, lockedUntil: null, sessionVersion: { increment: 1 } },
  create: {
    email: EMAIL,
    name: NAME,
    passwordHash,
    role: 'super_admin',
  },
  select: { id: true, email: true, name: true, role: true, createdAt: true, lastLoginAt: true },
});

console.log('');
console.log('========================================================');
console.log(' OPERATOR ACCOUNT READY — SAVE THE PASSWORD NOW');
console.log('========================================================');
console.log(' Email:    ', op.email);
console.log(' Name:     ', op.name);
console.log(' Role:     ', op.role);
if (generatedPassword) {
  console.log(' Password: ', password);
} else {
  console.log(' Password:  supplied by OPERATOR_PASSWORD (not printed)');
}
console.log('--------------------------------------------------------');
console.log(generatedPassword
  ? ' This password is shown ONCE. Save it to a password manager.'
  : ' Existing operator sessions were invalidated by sessionVersion bump.');
console.log(' Re-run this script to rotate.');
console.log('========================================================');
console.log('');
console.log('Sign in at: https://matflow.studio/admin/login');
console.log('  → "My account" tab → email + password above');
console.log('');

await prisma.$disconnect();
