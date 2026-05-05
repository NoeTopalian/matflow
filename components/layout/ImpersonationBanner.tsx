// Server component — renders a fixed red banner across the top of every
// dashboard page when an impersonation cookie is active. Reads the cookie
// directly (not the session) so it can show the impersonating-admin
// context even if the session has been overridden to the target user.

import { readImpersonationCookie } from "@/lib/impersonation";
import EndImpersonationButton from "./EndImpersonationButton";

export default async function ImpersonationBanner() {
  const imp = await readImpersonationCookie();
  if (!imp) return null;

  const expiresAt = new Date(imp.exp * 1000);
  const minsLeft = Math.max(0, Math.round((imp.exp * 1000 - Date.now()) / 60000));

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100,
        background: "#dc2626",
        color: "white",
        padding: "8px 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
        fontWeight: 500,
        boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        🛠 <strong>Admin impersonation active</strong> — {minsLeft}m left ·{" "}
        <span style={{ opacity: 0.85 }}>expires {expiresAt.toLocaleTimeString()}</span>
        {imp.reason && (
          <>
            {" · "}
            <em style={{ opacity: 0.85 }}>{imp.reason}</em>
          </>
        )}
      </span>
      <EndImpersonationButton />
    </div>
  );
}
