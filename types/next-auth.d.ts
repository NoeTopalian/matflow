import "next-auth";

declare module "next-auth" {
  interface User {
    role: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    primaryColor: string;
    secondaryColor: string;
    textColor: string;
    memberId?: string;
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
  }
}
