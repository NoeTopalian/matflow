import { createHmac } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

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
 */
export function hashToken(raw: string): string {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(raw).digest("hex");
}
