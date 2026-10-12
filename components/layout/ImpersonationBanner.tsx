// Server component — a fixed red banner across the top of every dashboard page
// while a SUPPORT session (operator "logged in as" this user) is live.
//
// It shows only when the support session is actually in force for this
// request — resolveActiveImpersonation() checks the same bindings auth.ts does
// (operator session, nonce, target version, club status) — so a stale cookie
// left after a stop or an operator sign-out does not paint a banner over a
// session that has already reverted. Support is read-only (lib/support-session.ts).

import { resolveActiveImpersonation } from "@/lib/impersonation";
import EndImpersonationButton from "./EndImpersonationButton";

export default async function ImpersonationBanner() {
  let active: Awaited<ReturnType<typeof resolveActiveImpersonation>> = null;
  try {
    active = await resolveActiveImpersonation();
  } catch {
    active = null;
  }
  if (!active) return null;
  const imp = active.payload;

  const expiresAt = new Date(imp.exp * 1000);
  // Audit iter-1-dashboard A4H-5: Date.now() in a Server Component renders
  // once per request — it's a render-time snapshot of "now" for the
  // minutes-remaining display, not a render-impurity bug.
  // eslint-disable-next-line react-hooks/purity
  const minsLeft = Math.max(0, Math.round((imp.exp * 1000 - Date.now()) / 60000));

  return (
    <div
      role="status"
      style={{
        // Audit O1: `fixed` overlaid the Topbar/mobile header with no
        // compensating padding — sticky keeps the banner pinned while
        // occupying normal flow, so nothing underneath is covered.
        position: "sticky",
        top: 0,
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
        <strong>MatFlow support session, read-only</strong> — {minsLeft}m left ·{" "}
        <span style={{ opacity: 0.85 }}>ends {expiresAt.toLocaleTimeString("en-GB")}</span>
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
