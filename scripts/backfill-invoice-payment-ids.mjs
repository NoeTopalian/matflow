// Backfill Payment.stripePaymentIntentId / stripeChargeId for rows the webhook
// wrote as NULL (audit P0-1).
//
// Cause: on apiVersion 2026-03-25.dahlia an Invoice has no `charge` and no
// `payment_intent` field, but app/api/stripe/webhook/route.ts read both through
// `Record<string, unknown>` casts. The reads returned undefined, so every
// subscription payment landed with null Stripe ids and nothing could reconcile
// against them — refunds, voids and disputes all match on those columns.
// The webhook is fixed; this repairs the rows written before the fix.
//
// The resolution logic mirrors lib/stripe/invoice-payment.ts (the canonical
// copy). Kept inline because this is a plain .mjs one-off and cannot import the
// TS module; if you change one, change both.
//
// SAFETY
//   * Stripe access is READ-ONLY (retrieve only). Nothing is created, updated
//     or deleted at Stripe.
//   * Writes touch only Payment rows, only the two id columns, and only where
//     they are currently NULL — so it is idempotent and cannot clobber a value
//     the fixed webhook has since written.
//   * DRY RUN by default. Pass --apply to write.
//   * Against the production database it additionally demands
//     --i-know-this-is-production, so it can never write to prod by accident.
//
// USAGE
//   node scripts/backfill-invoice-payment-ids.mjs                 # dry run
//   node scripts/backfill-invoice-payment-ids.mjs --apply         # write (non-prod)
//   node scripts/backfill-invoice-payment-ids.mjs --apply --i-know-this-is-production

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";
import "dotenv/config";

const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const PROD_ACK = args.has("--i-know-this-is-production");

const url = process.env.DATABASE_URL ?? "";
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const isProd = url.includes(PROD_NEON_ENDPOINT);
if (isProd && APPLY && !PROD_ACK) {
  console.error(
    "Refusing to write to PRODUCTION without --i-know-this-is-production.\n" +
      "Re-run with that flag if this is deliberate.",
  );
  process.exit(1);
}

if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY is not set — cannot resolve ids.");
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });

/** Mirrors lib/stripe/invoice-payment.ts. stripeAccount is the THIRD argument. */
async function resolveInvoicePaymentIds(invoiceId, stripeAccount) {
  const requestOptions = { stripeAccount };
  const invoice = await stripe.invoices.retrieve(
    invoiceId,
    { expand: ["payments"] },
    requestOptions,
  );

  // Newest-first, and non-paid entries (e.g. `canceled`) still carry a
  // payment_intent — prefer a paid one. Mirrors lib/stripe/invoice-payment.ts.
  const entries = invoice.payments?.data ?? [];
  const preferred = entries.find((e) => e.status === "paid") ?? entries[0];
  const intent = preferred?.payment?.payment_intent;
  const paymentIntentId = typeof intent === "string" ? intent : (intent?.id ?? null);
  if (!paymentIntentId) return { paymentIntentId: null, chargeId: null };

  const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, {}, requestOptions);
  const latest = paymentIntent.latest_charge;
  const chargeId = typeof latest === "string" ? latest : (latest?.id ?? null);
  return { paymentIntentId, chargeId };
}

async function main() {
  console.log(`DB      : ${isProd ? "PRODUCTION" : "non-production"}`);
  console.log(`Mode    : ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log("");

  const rows = await prisma.payment.findMany({
    where: {
      stripeInvoiceId: { not: null },
      OR: [{ stripePaymentIntentId: null }, { stripeChargeId: null }],
    },
    select: { id: true, tenantId: true, stripeInvoiceId: true, stripePaymentIntentId: true, stripeChargeId: true },
    orderBy: { id: "asc" },
  });

  if (rows.length === 0) {
    console.log("Nothing to backfill — no Payment rows with an invoice id and a missing payment id.");
    return;
  }
  console.log(`Found ${rows.length} Payment row(s) needing ids.\n`);

  // One Stripe account per tenant; cache so we do not re-read it per row.
  const accountByTenant = new Map();
  async function stripeAccountFor(tenantId) {
    if (!accountByTenant.has(tenantId)) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { stripeAccountId: true },
      });
      accountByTenant.set(tenantId, tenant?.stripeAccountId ?? null);
    }
    return accountByTenant.get(tenantId);
  }

  let resolved = 0, written = 0, unresolved = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const account = await stripeAccountFor(row.tenantId);
    if (!account) {
      skipped++;
      console.log(`  SKIP  ${row.id} — tenant ${row.tenantId} has no stripeAccountId`);
      continue;
    }

    let ids;
    try {
      ids = await resolveInvoicePaymentIds(row.stripeInvoiceId, account);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${row.id} — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!ids.paymentIntentId && !ids.chargeId) {
      unresolved++;
      console.log(`  NONE  ${row.id} — invoice ${row.stripeInvoiceId} has no payment recorded at Stripe`);
      continue;
    }

    // Only fill columns that are still NULL.
    const data = {};
    if (row.stripePaymentIntentId === null && ids.paymentIntentId) data.stripePaymentIntentId = ids.paymentIntentId;
    if (row.stripeChargeId === null && ids.chargeId) data.stripeChargeId = ids.chargeId;
    if (Object.keys(data).length === 0) { skipped++; continue; }

    resolved++;
    console.log(`  ${APPLY ? "WRITE" : "would"} ${row.id} -> ${JSON.stringify(data)}`);

    if (APPLY) {
      // Guarded on the columns still being NULL, so a concurrent webhook write
      // wins rather than being overwritten.
      const res = await prisma.payment.updateMany({
        where: {
          id: row.id,
          ...(data.stripePaymentIntentId ? { stripePaymentIntentId: null } : {}),
          ...(data.stripeChargeId ? { stripeChargeId: null } : {}),
        },
        data,
      });
      if (res.count === 1) written++;
      else console.log(`         (no-op — another writer got there first)`);
    }
  }

  console.log("");
  console.log(`resolved   : ${resolved}`);
  console.log(`written    : ${APPLY ? written : 0}${APPLY ? "" : " (dry run)"}`);
  console.log(`unresolved : ${unresolved}   (no payment at Stripe — e.g. never paid)`);
  console.log(`skipped    : ${skipped}`);
  console.log(`failed     : ${failed}`);
  if (!APPLY && resolved > 0) console.log("\nRe-run with --apply to write these.");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
