import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";

type AuthContext = {
  session: Session;
  tenantId: string;
  userId: string;
  role: string;
};

const STAFF_ROLES = ["owner", "manager", "coach", "admin"];

export async function requireSession(): Promise<AuthContext> {
  const session = await auth();
  if (!session) redirect("/login");
  return {
    session,
    tenantId: session.user.tenantId,
    userId: session.user.id,
    role: session.user.role,
  };
}

export async function requireRole(roles: string[], redirectTo = "/dashboard"): Promise<AuthContext> {
  const ctx = await requireSession();
  if (!roles.includes(ctx.role)) redirect(redirectTo);
  return ctx;
}

export async function requireOwner(): Promise<AuthContext> {
  return requireRole(["owner"]);
}

export async function requireOwnerOrManager(): Promise<AuthContext> {
  return requireRole(["owner", "manager"]);
}

export async function requireStaff(): Promise<AuthContext> {
  return requireRole(STAFF_ROLES);
}
