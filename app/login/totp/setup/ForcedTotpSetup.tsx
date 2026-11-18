"use client";

/**
 * Client body of /login/totp/setup — the TOTP enrolment UI. The forced-password
 * guard lives in the server component page.tsx that renders this (password is
 * changed before an authenticator is enrolled — W1 verifier FINDING-1).
 *
 * Which enrolment API it drives comes from the server render (`isMember`), not from a client session read.
 * TotpEnrollmentStep fetches `${apiPrefix}/setup` ONCE, on mount, so the route must be right on the first render.
 * Until 15 Nov 2026 it came from next-auth's client session hook, whose first render on a hard load has no session yet: a member was
 * sent to the staff route (/api/auth/totp/setup), refused, and shown "Could not initialise two-factor setup".
 */
import { useRouter } from "next/navigation";
import { SIGN_OUT_FAILED_MESSAGE, signOutThisDevice } from "@/lib/sign-out-client";
import { useToast } from "@/components/ui/Toast";
import TotpEnrollmentStep from "@/components/onboarding/TotpEnrollmentStep";

export default function ForcedTotpSetup({ isMember }: { isMember: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  // Audit N1/N2: members enrol via the member-side API mirror and land back
  // on their profile — previously this page drove the staff endpoints (401
  // for members) and redirected everyone to /dashboard.
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
          onClick={async () => {
            if (!(await signOutThisDevice())) toast(SIGN_OUT_FAILED_MESSAGE, "error", 8000);
          }}
          className="w-full mt-4 py-3 text-sm text-center transition-colors"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
