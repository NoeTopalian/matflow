import { redirect } from "next/navigation";
import { isAdminPageAuthed } from "@/lib/admin-auth";
import SecurityClient from "./SecurityClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function AdminSecurityPage() {
  if (!(await isAdminPageAuthed())) redirect("/admin/login");
  return <SecurityClient />;
}
