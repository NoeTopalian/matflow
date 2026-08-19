/**
 * Re-hydrate every connected tenant's cached `Tenant.stripeAccountStatus` from
 * Stripe. Use this after granting the platform key the `accounts_kyc_basic_read`
 * scope, to clear any cache that got poisoned to `chargesEnabled:false` while the
 * key was denied (which silently 503s checkout / class-pack / subscribe flows —
 * see lib/stripe-account-status.ts + app/api/member/checkout/route.ts).
 *
 *   node scripts/refresh-stripe-account-status.mjs            # dry-run (default) — reads only
 *   node scripts/refresh-stripe-account-status.mjs --apply    # write the fresh status back
 *
 * Reads STRIPE_SECRET_KEY + DATABASE_URL from .env. Mirrors the field shape and
 * the fail-open-on-permission-error semantics of refreshStripeAccountStatus()
 * so what it writes matches what the app would compute. Prints NO secrets.
 *
 * Doubles as the verification for the scope fix: every connected tenant should
 * print `charges=true` (real) rather than `permission-denied`.
 */
import { config } from "dotenv";
config();
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

const dbUrl = process.env.DATABASE_URL;
const key = process.env.STRIPE_SECRET_KEY;
if (!dbUrl) { console.error("✗ DATABASE_URL is not set."); process.exit(1); }
if (!key) { console.error("✗ STRIPE_SECRET_KEY is not set."); process.exit(1); }

const mode = /_live_/.test(key) ? "LIVE" : /_test_/.test(key) ? "TEST" : "UNKNOWN";
const Stripe = (await import("stripe")).default;
const stripe = new Stripe(key, { apiVersion: "2026-03-25.dahlia" });
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: dbUrl }) });

const line = "──────────────────────────────────────────────";
console.log(`\nRefresh Stripe account status  (${APPLY ? "APPLY" : "DRY-RUN"})  [${mode}]`);
console.log(line);

function isPermissionError(e) {
  return (
    e?.type === "StripePermissionError" ||
    /does not have the required permissions/i.test(e?.message ?? "")
  );
}

try {
  // Cross-tenant read — bypass RLS exactly like lib/prisma-tenant.ts withRlsBypass.
  const tenants = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.tenant.findMany({
      where: { stripeConnected: true, stripeAccountId: { not: null } },
      select: { id: true, name: true, stripeAccountId: true, stripeAccountStatus: true },
    });
  });

  if (tenants.length === 0) {
    console.log("No connected tenants (stripeConnected=true with a stripeAccountId). Nothing to do.\n");
    await prisma.$disconnect();
    process.exit(0);
  }
  console.log(`${tenants.length} connected tenant(s) to refresh.\n`);

  const updates = [];
  let denied = 0;
  for (const t of tenants) {
    const wasChargeable = t.stripeAccountStatus?.chargesEnabled ?? null;
    try {
      const acct = await stripe.accounts.retrieve(t.stripeAccountId);
      const status = {
        chargesEnabled: acct.charges_enabled === true,
        payoutsEnabled: acct.payouts_enabled === true,
        requirementsPastDue: acct.requirements?.past_due ?? [],
        disabledReason: acct.requirements?.disabled_reason ?? null,
        refreshedAt: new Date().toISOString(),
      };
      updates.push({ id: t.id, status });
      console.log(
        `✓ ${t.name} (${t.stripeAccountId}) cached=${wasChargeable} → charges=${status.chargesEnabled} ` +
          `payouts=${status.payoutsEnabled}${status.disabledReason ? ` disabled=${status.disabledReason}` : ""}`,
      );
    } catch (e) {
      if (isPermissionError(e)) {
        // Same fail-open marker the app now writes — unblocks checkout while
        // making the missing scope loud. Grant accounts_kyc_basic_read to get
        // real status.
        denied++;
        const status = {
          chargesEnabled: true,
          payoutsEnabled: true,
          requirementsPastDue: [],
          disabledReason: "status_unreadable",
          refreshedAt: new Date().toISOString(),
        };
        updates.push({ id: t.id, status });
        console.log(
          `⚠ ${t.name} (${t.stripeAccountId}) PERMISSION DENIED — key still lacks accounts read scope. ` +
            `Would write status_unreadable (chargesEnabled:true fallback).`,
        );
      } else {
        // Generic/network error — DON'T overwrite the existing cache (avoid
        // re-poisoning). Leave it and report.
        console.log(`✗ ${t.name} (${t.stripeAccountId}) error: ${e?.message ?? e} — left cache untouched.`);
      }
    }
  }

  console.log(line);
  if (denied > 0) {
    console.log(
      `⚠ ${denied} tenant(s) still permission-denied. Grant 'Basic Business Contact Information' ` +
        `(accounts_kyc_basic_read) READ to the key, then re-run for real status.`,
    );
  }

  if (!APPLY) {
    console.log(`(dry-run) Would write ${updates.length} tenant status row(s). Re-run with --apply to persist.\n`);
    await prisma.$disconnect();
    process.exit(0);
  }

  // Cross-tenant write — bypass RLS, one short transaction.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    for (const u of updates) {
      await tx.tenant.update({ where: { id: u.id }, data: { stripeAccountStatus: u.status } });
    }
  });
  console.log(`✓ Wrote fresh status for ${updates.length} tenant(s).\n`);
  await prisma.$disconnect();
  process.exit(0);
} catch (e) {
  console.error(`\n✗ Failed: ${e?.message ?? e}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
}
