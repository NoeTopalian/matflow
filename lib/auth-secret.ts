// Supports both NEXTAUTH_SECRET (new) and AUTH_SECRET (NextAuth v5 default / legacy Vercel deployments).
// Fails LOUDLY at import in production if neither is set, to avoid silently producing
// predictable HMACs in any worker that imports lib/encryption.ts or lib/checkin-token.ts.
const candidate = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";

if (!candidate && process.env.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build") {
  throw new Error("NEXTAUTH_SECRET or AUTH_SECRET must be set in production — refusing to sign with empty key");
}

export const AUTH_SECRET_VALUE = candidate;
