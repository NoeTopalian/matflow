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
import { signOut } from "next-auth/react";
import TotpEnrollmentStep from "@/components/onboarding/TotpEnrollmentStep";

export default function ForcedTotpSetupPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: "#0a0a0f" }}>
      <div className="w-full max-w-md">
        <TotpEnrollmentStep
          // Standalone surface uses the brand amber for visual continuity with
          // the prior dedicated-page styling; wizard callers pass the tenant
          // primaryColor instead.
          primaryColor="#f59e0b"
          onAlreadyEnabled={() => router.push("/dashboard")}
          onComplete={() => {
            router.push("/dashboard");
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
