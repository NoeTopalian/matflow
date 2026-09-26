/**
 * Shown on the dashboard when a staff member was sent back from a page their
 * role cannot open. Until 26 Sep 2026 the redirect was silent: a coach
 * pressing Settings landed on the dashboard with no explanation (customer
 * simulation F-9). The page name is not carried — the redirect comes from a
 * shared guard — so the sentence names the roles instead.
 */
import { Card } from "@/components/ui/card";
import { ShieldAlert } from "lucide-react";

const ROLE_LABEL: Record<string, string> = { manager: "managers", coach: "coaches", admin: "front-desk admins" };

export default function DeniedNotice({ role }: { role: string }) {
  const who = ROLE_LABEL[role] ?? "your role";
  return (
    <Card className="flex items-start gap-3 border-l-4" style={{ borderLeftColor: "var(--hue-warning)" }} role="status">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" style={{ color: "var(--hue-warning-ink)" }} aria-hidden="true" />
      <div className="text-sm">
        <p className="font-medium text-tx-1">That page isn&apos;t open to {who}.</p>
        <p className="mt-0.5 text-tx-3">
          Settings and Memberships are for the owner; Payments and Reports are for the owner and managers. Ask the owner if you need something changed there.
        </p>
      </div>
    </Card>
  );
}
