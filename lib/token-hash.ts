import { createHmac } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { isRootKeyContext } from "@/lib/key-contexts";

/**
 * HMAC-SHA256 a raw bearer token so it can be stored at rest without leaking
 * an attacker-usable value if the database is dumped, exported via support
 * tooling, or surfaced in a query log.
 *
 * Used for MagicLinkToken.tokenHash and PasswordResetToken.tokenHash. The
 * raw token is sent to the user via email (the only place that needs it);
 * the DB stores only the hash. On consume, we re-hash the incoming token
 * and look up by tokenHash via Prisma's @unique index — that lookup is
 * itself constant-time at the DB level.
 *
 * Deterministic, so the same raw input always produces the same hash —
 * required for the @unique index lookup to work.
 *
 * NEVER A SUB-KEY (R6-N2, security campaign iteration 2, lane A4, 10 Oct 2026). This is a raw HMAC under the root
 * secret over caller-influenced input (a token from a URL, an email address for the DSAR export's memberEmailHash),
 * and sub-keys are HMAC(root, context) — so hashToken("matflow.kiosk.v1") WAS the kiosk signing key in hex. An input
 * exactly equal to a registered key context (lib/key-contexts) is now MAC'd under a reserved prefix instead. Only
 * those exact strings change; every stored hash (magic-link, reset, invite, kiosk and leaderboard tokens, recovery
 * codes, DSAR email hashes) is computed over a value that is never a context and is byte-identical — prefixing ALL
 * input would have invalidated every outstanding kiosk token and recovery code. Pinned by fixed-key vectors in
 * tests/unit/sec-a4-subkey-separation.test.ts.
 */
export function hashToken(raw: string): string {
  const input = isRootKeyContext(raw) ? `token-hash:reserved-context:v1:${raw}` : raw;
  return createHmac("sha256", AUTH_SECRET_VALUE).update(input).digest("hex");
}
