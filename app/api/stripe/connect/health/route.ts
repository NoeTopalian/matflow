/**
 * GET /api/stripe/connect/health
 *
 * Owner-only diagnostic. Returns a JSON of which Stripe Connect env vars
 * + dashboard config are detectable from the running app, with the actual
 * secret values redacted. Designed to answer the question "is my Stripe
 * Connect set up correctly so my owners can OAuth in?"
 *
 * Surfaces:
 *  - presence + masked prefix of STRIPE_CLIENT_ID (must start `ca_`)
 *  - presence + mode (live/test) of STRIPE_SECRET_KEY (sk_live_ vs sk_test_)
 *  - presence of STRIPE_WEBHOOK_SECRET
 *  - the redirect URI MatFlow will register at the OAuth start
 *  - if STRIPE_SECRET_KEY is set, attempts to fetch the platform account
 *    metadata from Stripe to confirm the key actually works
 *  - this tenant's current stripeConnected + stripeAccountStatus snapshot
 *
 * No secrets leaked beyond first ~4 chars / last ~4 chars of identifiers.
 */
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { apiError } from "@/lib/api-error";
import { getBaseUrl } from "@/lib/env-url";

export const runtime = "nodejs";

function mask(value: string | undefined, prefix: number = 4, suffix: number = 4): string | null {
  if (!value) return null;
  if (value.length <= prefix + suffix) return "***";
  return `${value.slice(0, prefix)}…${value.slice(-suffix)}`;
}

export async function GET(req: Request) {
  const { tenantId } = await requireOwner();

  const clientId = process.env.STRIPE_CLIENT_ID;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const rawNextauthUrl = process.env.NEXTAUTH_URL;
  const cleanedBase = getBaseUrl(req);

  const expectedRedirectUri = `${cleanedBase}/api/stripe/connect/callback`;
  const nextauthNeedsCleanup =
    !!rawNextauthUrl && rawNextauthUrl.replace(/\/+$/, "") !== rawNextauthUrl.trim().replace(/\/+$/, "");

  // Detect mode from secret key prefix
  const secretMode = !secretKey
    ? null
    : secretKey.startsWith("sk_live_")
    ? "live"
    : secretKey.startsWith("sk_test_")
    ? "test"
    : "unknown";

  // Validate STRIPE_CLIENT_ID format (must be ca_...)
  const clientIdLooksValid = clientId ? clientId.startsWith("ca_") : false;

  const env = {
    STRIPE_CLIENT_ID: {
      present: !!clientId,
      masked: mask(clientId),
      formatLooksValid: clientIdLooksValid,
      expectedFormat: "ca_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    },
    STRIPE_SECRET_KEY: {
      present: !!secretKey,
      masked: mask(secretKey, 7, 4),
      mode: secretMode,
    },
    STRIPE_WEBHOOK_SECRET: {
      present: !!webhookSecret,
      masked: mask(webhookSecret, 6, 4),
    },
    NEXTAUTH_URL: {
      present: !!rawNextauthUrl,
      value: cleanedBase || null,
      rawValue: rawNextauthUrl ?? null,
      needsCleanup: nextauthNeedsCleanup,
    },
  };

  // Live-probe: if secret key is set, try a tiny Stripe API call to verify
  // it works. This catches "secret key set but expired/revoked" cases.
  let platformAccount: {
    ok: boolean;
    connectAccountCount?: number;
    balanceCurrency?: string | null;
    error?: string;
  } = { ok: false };

  if (secretKey) {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(secretKey, { apiVersion: "2026-03-25.dahlia" });
      // Test the key by listing Connect accounts (limit 1). This succeeds
      // only if the key is valid AND belongs to a Stripe Connect platform.
      // If the platform has no connected accounts yet the response is just
      // an empty array — still a successful API call.
      const accounts = await stripe.accounts.list({ limit: 1 });
      // Also fetch balance to confirm the key has read access.
      const balance = await stripe.balance.retrieve();
      platformAccount = {
        ok: true,
        connectAccountCount: accounts.data.length,
        balanceCurrency: balance.available[0]?.currency ?? null,
      };
    } catch (e) {
      platformAccount = {
        ok: false,
        error: e instanceof Error ? e.message : "Unknown Stripe error",
      };
    }
  }

  // This tenant's current Connect state
  const tenant = await withTenantContext(tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: tenantId },
      select: { stripeConnected: true, stripeAccountId: true, stripeAccountStatus: true, acceptsBacs: true },
    }),
  ).catch(() => null);

  const overallReady =
    env.STRIPE_CLIENT_ID.present &&
    env.STRIPE_CLIENT_ID.formatLooksValid &&
    env.STRIPE_SECRET_KEY.present &&
    env.STRIPE_WEBHOOK_SECRET.present &&
    env.NEXTAUTH_URL.present &&
    platformAccount.ok;

  return NextResponse.json({
    ready: overallReady,
    env,
    platformAccount,
    expectedRedirectUri,
    redirectUriRegistrationHint: `Ensure the URI above is added in your Stripe dashboard at: Connect → Settings → Integration → Redirects`,
    thisTenant: {
      tenantId,
      stripeConnected: tenant?.stripeConnected ?? null,
      stripeAccountId: mask(tenant?.stripeAccountId ?? undefined, 5, 4),
      acceptsBacs: tenant?.acceptsBacs ?? null,
      stripeAccountStatus: tenant?.stripeAccountStatus ?? null,
    },
    nextSteps: [
      // Always-relevant cleanup warning when env has whitespace/trailing slash.
      nextauthNeedsCleanup &&
        "⚠️ Your NEXTAUTH_URL env var contains whitespace or a trailing slash. The app trims defensively, but clean it at the source: Vercel → Settings → Environment Variables → NEXTAUTH_URL → ensure value is exactly 'https://matflow.studio' with no trailing whitespace.",
      ...(overallReady
        ? ["✅ Configuration looks complete. An owner can now Connect Stripe via Settings → Revenue or Wizard Step 7."]
        : [
            !env.STRIPE_CLIENT_ID.present && "Set STRIPE_CLIENT_ID in Vercel env (get it from Stripe Dashboard → Connect → Settings → OAuth → live mode client_id, format ca_...)",
            env.STRIPE_CLIENT_ID.present && !env.STRIPE_CLIENT_ID.formatLooksValid && "STRIPE_CLIENT_ID is set but doesn't start with 'ca_' — verify you copied the right value.",
            !env.STRIPE_SECRET_KEY.present && "Set STRIPE_SECRET_KEY in Vercel env (sk_live_... for prod or sk_test_... for testing).",
            !env.STRIPE_WEBHOOK_SECRET.present && "Set STRIPE_WEBHOOK_SECRET in Vercel env (whsec_... from your webhook endpoint config in Stripe dashboard).",
            !env.NEXTAUTH_URL.present && "Set NEXTAUTH_URL in Vercel env (e.g. https://matflow.studio) — used to build the OAuth redirect URI.",
            env.STRIPE_SECRET_KEY.present && !platformAccount.ok && `Stripe API call failed with the configured key: ${platformAccount.error}. Check the key is valid + not revoked.`,
          ]),
    ].filter(Boolean),
  });
}
