"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/**
 * 2FA-optional spec (2026-05-07): client-side recommendation banner for the
 * member surface. Mounted in app/member/layout.tsx (which is itself a client
 * component). Fetches /api/member/me to learn whether the current member has
 * a password (enrolment is gated to password-bearing members) and whether
 * TOTP is already enabled. Banner renders only when:
 *
 *   hasPassword === true AND totpEnabled === false
 *
 * Magic-link-only members (no password) and kid members never see this.
 */
export default function Recommend2FABannerMember() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/member/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.hasPassword === true && data.totpEnabled === false) {
          setShow(true);
        }
      })
      .catch(() => { /* offline / demo — banner stays hidden */ });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="w-full flex items-center justify-between gap-3 px-4 py-2 text-xs"
      style={{
        background: "rgba(245, 158, 11, 0.10)",
        borderBottom: "1px solid rgba(245, 158, 11, 0.25)",
        color: "#fbbf24",
      }}
      role="status"
    >
      <div className="flex items-center gap-2 min-w-0">
        <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#f59e0b" }} aria-hidden />
        <span className="truncate">
          <strong className="font-semibold">Two-factor authentication is recommended.</strong>{" "}
          Set up now to protect your account. (Note: magic-link login does not require 2FA — use password login for full second-factor protection.)
        </span>
      </div>
      <Link
        href="/login/totp/setup"
        className="shrink-0 px-2.5 py-1 rounded-md font-semibold whitespace-nowrap"
        style={{
          background: "rgba(245, 158, 11, 0.18)",
          color: "#fbbf24",
          border: "1px solid rgba(245, 158, 11, 0.35)",
        }}
      >
        Set up
      </Link>
    </div>
  );
}
