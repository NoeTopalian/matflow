// /admin/activity — cross-tenant audit-log feed for the operator.
// Server shell renders an initial fetch; client component handles
// filters + pagination.

import ActivityFeed from "./ActivityFeed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function AdminActivityPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <ActivityFeed />
      </div>
    </div>
  );
}
