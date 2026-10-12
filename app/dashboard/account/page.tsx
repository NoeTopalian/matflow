import { requireStaff } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { PageHeader } from "@/components/ui/page-header";
import ProfileCard from "@/components/dashboard/ProfileCard";
import LoginEmailCard from "@/components/dashboard/LoginEmailCard";
import PasswordCard from "@/components/dashboard/PasswordCard";
import AccountTotpStatus from "@/components/dashboard/AccountTotpStatus";

/**
 * My account (8 Oct 2026, account-editing lane R): every staff role — owner,
 * manager, coach, admin — edits their OWN name, login email and password here.
 * Settings is owner-only, so before this page a manager, coach or admin had no
 * account screen at all. The owner has the same cards under Settings → Account
 * (with recovery-code regeneration); this page is the one every role can reach.
 *
 * Each card talks to a route that acts on the session user only:
 *   name        → PATCH /api/account/profile
 *   login email → POST  /api/account/login-email (password + code)
 *   password    → POST  /api/account/password    (password + code)
 * The authenticator is enrolled at /login/totp/setup and reset only by the club
 * owner (Settings → Staff) or, for an owner, MatFlow support.
 *
 * UI-RULES §7: no try/catch — a load failure reaches app/dashboard/error.tsx.
 */
export default async function AccountPage() {
  const { tenantId, userId, role } = await requireStaff();
  const me = await withTenantContext(tenantId, (tx) =>
    tx.user.findFirst({ where: { id: userId, tenantId }, select: { totpEnabled: true } }),
  );
  const totpEnabled = me?.totpEnabled === true;

  return (
    <div className="max-w-3xl">
      <PageHeader title="My account" description="Your own name and sign-in details. Changes here affect only your account." />
      <div className="space-y-4">
        <ProfileCard />
        <LoginEmailCard />
        <PasswordCard totpEnabled={totpEnabled} />
        <AccountTotpStatus totpEnabled={totpEnabled} isOwner={role === "owner"} />
      </div>
    </div>
  );
}
