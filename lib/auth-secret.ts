// Supports both NEXTAUTH_SECRET (new) and AUTH_SECRET (NextAuth v5 default / legacy Vercel deployments)
export const AUTH_SECRET_VALUE =
  process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
