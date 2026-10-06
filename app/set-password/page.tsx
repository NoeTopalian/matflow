/**
 * /set-password — where a staff user lands after an operator reset, until they
 * have chosen their own password (F-3). Outside the /dashboard layout so the
 * layout's own gate cannot loop back here.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { STAFF_ROLES } from "@/lib/authz";
import SetPasswordForm from "@/components/auth/SetPasswordForm";
import ImpersonationBanner from "@/components/layout/ImpersonationBanner";

export default async function SetPasswordPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!STAFF_ROLES.includes(session.user.role)) redirect("/member/home");
  const user = await withTenantContext(session.user.tenantId, (tx) =>
    tx.user.findFirst({ where: { id: session.user.id, tenantId: session.user.tenantId }, select: { mustChangePassword: true, name: true } }),
  ).catch(() => null);
  if (!user?.mustChangePassword) redirect("/dashboard");
  // Support sessions can land here (a pending owner): the banner says so, and
  // the form's POST is refused for them (lib/support-session.ts).
  return (
    <>
      <ImpersonationBanner />
      <SetPasswordForm name={user.name} />
    </>
  );
}
