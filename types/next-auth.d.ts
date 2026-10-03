import "next-auth";

declare module "next-auth" {
  // Shape returned by the Credentials `authorize()` callback and by the
  // Google OAuth `signIn()` branch in auth.ts — both hand these fields to
  // the `jwt()` callback, so they belong on User rather than being cast away.
  interface User {
    role: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    primaryColor: string;
    secondaryColor: string;
    textColor: string;
    memberId?: string;
    // Bumped on password change / forced logout; compared against the JWT.
    sessionVersion?: number;
    // 2FA-optional spec (2026-05-07). Only some authorize() branches set
    // requireTotpSetup, hence optional across the board.
    totpPending?: boolean;
    requireTotpSetup?: boolean;
    totpEnabled?: boolean;
    // True while the account is on a temporary password (operator reset or an
    // owner-chosen staff password). Gates /set-password, the API, and since
    // 3 Oct 2026 the magic-link and forgot-password doors.
    mustChangePassword?: boolean;
  }

  interface Session {
    user: {
      id: string;
      email: string;
      name: string;
      role: "owner" | "manager" | "coach" | "admin" | "member";
      tenantId: string;
      tenantSlug: string;
      tenantName: string;
      primaryColor: string;
      secondaryColor: string;
      textColor: string;
      memberId?: string;
      totpPending?: boolean;
      requireTotpSetup?: boolean;
      // 2FA-optional spec (2026-05-07): ground truth for the dashboard 2FA
      // recommendation banner. False on session = user has not enrolled.
      totpEnabled?: boolean;
      mustChangePassword?: boolean;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    primaryColor: string;
    secondaryColor: string;
    textColor: string;
    memberId?: string | null;
    totpPending?: boolean;
    requireTotpSetup?: boolean;
    totpEnabled?: boolean;
    mustChangePassword?: boolean;
  }
}
