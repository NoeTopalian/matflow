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
  }
}
