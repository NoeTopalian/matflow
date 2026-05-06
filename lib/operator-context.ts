// Resolve the current operator (super-admin) context.
//
// v1: Every admin route uses the shared `MATFLOW_ADMIN_SECRET` cookie. There's
// no individual operator identity, so audit-log entries stamp the sentinel id
// `__matflow_super_admin__`.
//
// v1.5 (deferred): When the Operator table has rows + a real session cookie,
// this helper resolves the actual operator's id and email so audit logs
// distinguish "Noe did X" from "Sarah did Y". Call sites don't change — they
// always pass `actAsUserId: ctx.operatorId` to logAudit.

import { isAdminAuthed } from "@/lib/admin-auth";

export type OperatorContext = {
  operatorId: string;       // sentinel in v1, real Operator.id in v1.5
  operatorEmail: string | null;
  authed: boolean;
};

export const SENTINEL_OPERATOR_ID = "__matflow_super_admin__";

export async function getOperatorContext(req: Request): Promise<OperatorContext> {
  const authed = await isAdminAuthed(req);
  return {
    operatorId: SENTINEL_OPERATOR_ID,
    operatorEmail: null,
    authed,
  };
}
