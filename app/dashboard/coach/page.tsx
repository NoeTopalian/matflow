import { requireStaff } from "@/lib/authz";
import CoachRegister from "@/components/dashboard/CoachRegister";

export const metadata = { title: "Coach Register | MatFlow" };

export default async function CoachPage() {
  const { session } = await requireStaff();
  return <CoachRegister primaryColor={session.user.primaryColor ?? "#3b82f6"} />;
}
