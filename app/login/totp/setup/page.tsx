/**
 * /login/totp/setup — mandatory TOTP enrolment surface for owners (and the
 * recovery re-enrol path). proxy.ts pins a not-yet-enrolled owner here via the
 * requireTotpSetup redirect.
 *
 * Server shell: it enforces password-before-TOTP. A reset owner still carrying
 * a temporary password (mustChangePassword) is sent to /set-password FIRST, so
 * they never enrol an authenticator against an operator-issued temp password
 * (W1 verifier FINDING-1, 1 Oct 2026). mustChangePassword is DB truth, not on
 * the session, so it is read here rather than in the middleware. The enrolment
 * UI itself is the client component ForcedTotpSetup.
 */
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import ForcedTotpSetup from "./ForcedTotpSetup";

export default async function ForcedTotpSetupPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Staff only: members reach this page for their own enrolment and have no
  // forced-password step.
  if (session.user.role !== "member") {
    const user = await withTenantContext(session.user.tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: session.user.id, tenantId: session.user.tenantId },
        select: { mustChangePassword: true },
      }),
    );
    if (user?.mustChangePassword) redirect("/set-password");
  }

  return <ForcedTotpSetup />;
}
