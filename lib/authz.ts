import { auth } from "@/auth";
import { redirect } from "next/navigation";
import type { Session } from "next-auth";

/**
 * PAGE-ROUTE auth gates. Every helper in this file answers an auth failure
 * with `redirect()`, which is correct for a server component: the browser
 * is doing a document navigation and wants to land on /login.
 *
 * It is WRONG for a route handler. Next.js converts the `NEXT_REDIRECT`
 * throw into `new Response(null, { status: 307, Location: "/login" })`
 * (see next/dist/server/route-modules/app-route/module.js). `fetch()`
 * follows that redirect by default, so the client receives the login
 * PAGE — 200 OK, `text/html` — and `res.json()` throws. The caller's catch
 * branch then renders an empty state, telling the user they have no data
 * when the truth is that their session expired.
 *
 * Route handlers under app/api/** must therefore use `@/lib/api-authz`,
 * which returns a JSON 401/403 instead.
 */

export type AuthContext = {
  session: Session;
  tenantId: string;
  userId: string;
  role: string;
};

export const STAFF_ROLES: string[] = ["owner", "manager", "coach", "admin"];

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
