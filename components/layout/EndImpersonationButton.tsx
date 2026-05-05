"use client";

// Tiny client button that ends an impersonation session by calling the
// DELETE endpoint and redirecting back to /admin/tenants. Used inside the
// (server-rendered) ImpersonationBanner.

import { useState } from "react";

export default function EndImpersonationButton() {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const res = await fetch("/api/admin/impersonate", { method: "DELETE" });
          const data = await res.json().catch(() => ({}));
          window.location.href = data?.redirectTo ?? "/admin/tenants";
        } catch {
          setPending(false);
        }
      }}
      style={{
        background: "white",
        color: "#dc2626",
        border: "none",
        padding: "4px 12px",
        borderRadius: 6,
        fontSize: 12,
        fontWeight: 600,
        cursor: pending ? "not-allowed" : "pointer",
        opacity: pending ? 0.6 : 1,
      }}
    >
      {pending ? "Ending…" : "End impersonation →"}
    </button>
  );
}
