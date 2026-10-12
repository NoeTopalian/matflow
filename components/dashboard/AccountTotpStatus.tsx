"use client";

// My account → Two-factor authentication status (8 Oct 2026, lane R). Status
// and where to go; enrolment is /login/totp/setup, reset is the club owner
// (Settings → Staff) or, for an owner, MatFlow support. Client component only
// because buttonVariants lives in a client module.

import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default function AccountTotpStatus({ totpEnabled, isOwner }: { totpEnabled: boolean; isOwner: boolean }) {
  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <h2 className="font-semibold text-sm mb-1" style={{ color: "var(--tx-1)" }}>Two-factor authentication</h2>
      {totpEnabled ? (
        <p className="text-xs" style={{ color: "var(--tx-3)" }}>
          An authenticator code is required every time you sign in. It cannot be turned off from here. If you lose your authenticator,
          {isOwner
            ? " use a recovery code, or ask MatFlow support to reset it after checking it is you. Regenerate recovery codes under Settings → Account."
            : " use a recovery code, or ask your club owner to reset it (Settings → Staff)."}
        </p>
      ) : (
        <>
          <p className="text-xs mb-3" style={{ color: "var(--tx-3)" }}>
            Not set up. Strongly recommended — it adds an authenticator app code to every sign-in.
          </p>
          <Link href="/login/totp/setup" className={buttonVariants({ variant: "secondary", size: "compact" })}>
            Set up an authenticator
          </Link>
        </>
      )}
    </div>
  );
}
