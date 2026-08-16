"use client";

/**
 * /login/totp/setup — recovery / fallback TOTP enrolment surface.
 *
 * Owners who land here:
 *   - Existing accounts (pre-rollout) that haven't enrolled yet — proxy.ts
 *     pins them here via the `requireTotpSetup` redirect.
 *   - Owners who lost their device + recovery codes and reset via support —
 *     this is where they re-enrol.
 *
 * The wizard at /onboarding now hosts the primary enrolment path for new
 * owners (see components/onboarding/OwnerOnboardingWizard.tsx). Both paths
 * render the same UI from components/onboarding/TotpEnrollmentStep.tsx.
 */
import { useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import TotpEnrollmentStep from "@/components/onboarding/TotpEnrollmentStep";

export default function ForcedTotpSetupPage() {
  const router = useRouter();
  const { data: session } = useSession();
  // Audit N1/N2: members enrol via the member-side API mirror and land back
  // on their profile — previously this page drove the staff endpoints (401
  // for members) and redirected everyone to /dashboard.
  const isMember = session?.user?.role === "member";
  const home = isMember ? "/member/profile" : "/dashboard";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: "#0a0a0f" }}>
      <div className="w-full max-w-md">
        <TotpEnrollmentStep
          // Standalone surface uses the brand amber for visual continuity with
          // the prior dedicated-page styling; wizard callers pass the tenant
          // primaryColor instead.
          primaryColor="#f59e0b"
          apiPrefix={isMember ? "/api/member/totp" : "/api/auth/totp"}
          onAlreadyEnabled={() => router.push(home)}
          onComplete={() => {
            router.push(home);
            router.refresh();
          }}
        />

        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full mt-4 py-3 text-sm text-center transition-colors"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
