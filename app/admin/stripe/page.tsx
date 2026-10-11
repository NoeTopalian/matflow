// /admin/stripe — Stripe sync state per club: connection, event store counts,
// failed and unprocessed events with operator replay, and the last reconcile
// run (payments lane PD, 11 Oct 2026; audit §19). Read-only apart from Replay,
// which needs a fresh authenticator code and a reason.

import { redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import { adminContainer, adminPage } from "../admin-theme";
import AdminTopNav from "../AdminTopNav";
import StripeSyncPanel from "@/components/admin/stripe/StripeSyncPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminStripePage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");
  return (
    <div style={adminPage}>
      <AdminTopNav />
      <div style={adminContainer}>
        <header className="mb-6">
          <h1 className="text-[22px] font-semibold text-tx-1">Stripe sync</h1>
          <p className="text-[13px] text-tx-3">
            Webhook events by club, failed and unprocessed events, and the daily reconciliation.
          </p>
        </header>
        <StripeSyncPanel />
      </div>
    </div>
  );
}
