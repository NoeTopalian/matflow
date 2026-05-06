// Resolve the current operator (super-admin) context.
//
// v1: Admin route uses the shared `MATFLOW_ADMIN_SECRET` cookie or header.
// There's no individual operator identity, so audit-log entries stamp the
// sentinel id `__matflow_super_admin__`.
//
// v1.5: When the v1.5 session cookie (`matflow_op_session`) is present and
// validates against the Operator table, this helper resolves the actual
// operator's id and email so audit logs distinguish "Noe did X" from
// "Sarah did Y". Call sites don't change — they always pass
// `actAsUserId: ctx.operatorId` to logAudit.
//
// Resolution order:
//   1. v1.5 operator session cookie  → real Operator.id + email
//   2. v1 admin secret cookie/header → SENTINEL_OPERATOR_ID + null email
//   3. neither validates             → authed: false

import { cookies } from "next/headers";
import { isAdminAuthed } from "@/lib/admin-auth";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";

export type OperatorContext = {
  operatorId: string;       // real Operator.id when v1.5 session present, sentinel otherwise
  operatorEmail: string | null;
  operatorName: string | null;
  authed: boolean;
};

export const SENTINEL_OPERATOR_ID = "__matflow_super_admin__";

export async function getOperatorContext(req: Request): Promise<OperatorContext> {
  // v1.5 path: real operator session
  const store = await cookies();
  const sessionValue = store.get(OP_SESSION_COOKIE)?.value;
  const op = await resolveOperatorFromCookie(sessionValue);
  if (op) {
    return {
      operatorId: op.id,
      operatorEmail: op.email,
      operatorName: op.name,
      authed: true,
    };
  }

  // v1 fallback: shared secret (header or cookie)
  const authed = await isAdminAuthed(req);
  return {
    operatorId: SENTINEL_OPERATOR_ID,
    operatorEmail: null,
    operatorName: null,
    authed,
  };
}
