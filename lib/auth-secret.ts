// Supports both NEXTAUTH_SECRET (new) and AUTH_SECRET (NextAuth v5 default / legacy Vercel deployments).
// Fails LOUDLY at import in production if neither is set, to avoid silently producing
// predictable HMACs in any worker that imports lib/encryption.ts or lib/totp.ts.
//
// A BLANK VALUE IS UNSET (R6-N6, security campaign iteration 2, lane A4, 10 Oct 2026). This read
// `NEXTAUTH_SECRET ?? AUTH_SECRET`, and `??` falls through only on undefined: NEXTAUTH_SECRET="" with AUTH_SECRET
// set signed every HMAC with a zero-length key outside production (R6 measured key length 0 in a TEST run), and in
// production refused to start although AUTH_SECRET was set. An empty or whitespace-only value now falls through
// to the next variable, and an empty effective secret in production throws at import as before. The value that IS
// used is never trimmed or altered — a real secret with a trailing newline keeps every key derived from it.
function usable(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

const candidate = usable(process.env.NEXTAUTH_SECRET) ?? usable(process.env.AUTH_SECRET) ?? "";

if (!candidate && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
  throw new Error("NEXTAUTH_SECRET or AUTH_SECRET must be set in production — refusing to sign with empty key");
}

export const AUTH_SECRET_VALUE = candidate;
