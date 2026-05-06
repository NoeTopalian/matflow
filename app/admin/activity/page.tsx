// /admin/activity — cross-tenant audit-log feed for the operator.
// Server shell renders an initial fetch; client component handles
// filters + pagination.

import { redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import ActivityFeed from "./ActivityFeed";
import { adminContainer, adminPage } from "../admin-theme";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminActivityPage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");

  return (
    <div style={adminPage}>
      <div style={adminContainer}>
        <ActivityFeed />
      </div>
    </div>
  );
}
