import { randomBytes } from "crypto";
import { hashToken } from "@/lib/token-hash";

/**
 * TOTP recovery codes (Wizard v2 Step 2 / Fix 4 follow-up).
 *
 * One-time codes shown to the owner once at TOTP enrolment, then never again.
 * Stored as HMAC hashes in User.totpRecoveryCodes (JSON array). Consuming a
 * code removes that hash from the array — codes can only be used once.
 *
 * Format: 10-character lowercase hex chunks displayed as "XXXX-XXXX-XX" for
 * readability, but stored without the dashes. Comparison strips dashes too.
 */

const CODE_COUNT = 8;
const RAW_BYTE_LENGTH = 5; // 5 bytes -> 10 hex chars

export type RecoveryCodePair = {
  /** The user-visible code, formatted as XXXX-XXXX-XX. */
  display: string;
  /** The HMAC hash to persist. */
  hash: string;
};

/**
 * Generate `CODE_COUNT` fresh recovery codes. Returns both the display
 * strings (one-time-only — show then discard) and their hashes (persist).
 */
export function generateRecoveryCodes(count: number = CODE_COUNT): RecoveryCodePair[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(RAW_BYTE_LENGTH).toString("hex"); // 10 lowercase hex chars
    return {
      display: formatForDisplay(raw),
      hash: hashToken(raw),
    };
  });
}

/**
 * Display formatting: "abcd1234ef" -> "abcd-1234-ef".
 * Easier to read aloud, type from a notes app, etc.
 */
export function formatForDisplay(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-f0-9]/g, "");
  return `${clean.slice(0, 4)}-${clean.slice(4, 8)}-${clean.slice(8, 10)}`;
}

/**
 * Normalise a user-supplied code (strip dashes, whitespace, uppercase) ready
 * for hashing + comparison.
 */
export function normaliseUserCode(input: string): string {
  return input.toLowerCase().replace(/[^a-f0-9]/g, "");
}

/**
 * Verify a user-supplied recovery code against the stored hash array.
 * Returns the new array (with the matching hash removed) if valid, or null
 * if no match. Caller persists the new array if non-null.
 */
export function consumeRecoveryCode(
  userInput: string,
  storedHashes: string[],
): { ok: true; remaining: string[] } | { ok: false } {
  const normalised = normaliseUserCode(userInput);
  if (normalised.length !== RAW_BYTE_LENGTH * 2) return { ok: false };
  const candidateHash = hashToken(normalised);
  const idx = storedHashes.indexOf(candidateHash);
  if (idx === -1) return { ok: false };
  const remaining = [...storedHashes.slice(0, idx), ...storedHashes.slice(idx + 1)];
  return { ok: true, remaining };
}

export function recoveryCodeArrayFromJson(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}
