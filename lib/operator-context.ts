// Resolve the current operator (super-admin) context.
//
// Resolution order (operator auth hardening, 6 Oct 2026):
//   1. MFA-verified operator session cookie → real Operator.id + email
//   2. development/test only: the shared secret (header or cookie)
//      → SENTINEL_OPERATOR_ID + null email. In production the shared secret
//      grants nothing (lib/admin-auth.ts sharedAdminSecretPermitted), so this
//      branch answers authed: false there.
//   3. neither validates → authed: false
//
// `named` is true only for (1). Anything that needs a real person behind the
// request — step-up re-authentication above all — must check it: the sentinel
// has no authenticator to re-prove.

//
// Allowlist (9 Oct 2026): resolveOperatorFromCookie refuses an MFA session whose
// operator id is not in OPERATOR_ALLOWED_IDS and records it; the fallback below
// resolves the same cookie again through isAdminAuthed, and the refusal row is
// written once per request (lib/operator-auth.ts recordOperatorRefusal).

import { cookies } from "next/headers";
import { isAdminAuthed } from "@/lib/admin-auth";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";

export type OperatorContext = {
  operatorId: string;       // real Operator.id when a named session is present, sentinel otherwise
  operatorEmail: string | null;
  operatorName: string | null;
  authed: boolean;
  /** True only when a named, MFA-verified operator session resolved. */
  named: boolean;
};

export const SENTINEL_OPERATOR_ID = "__matflow_super_admin__";

export async function getOperatorContext(req: Request): Promise<OperatorContext> {
  const store = await cookies();
  const sessionValue = store.get(OP_SESSION_COOKIE)?.value;
  const op = await resolveOperatorFromCookie(sessionValue, { req });
  if (op) {
    return {
      operatorId: op.id,
      operatorEmail: op.email,
      operatorName: op.name,
      authed: true,
      named: true,
    };
  }

  // Development/test fallback: shared secret (header or cookie). Refused in
  // production by isAdminAuthed itself.
  const authed = await isAdminAuthed(req);
  return {
    operatorId: SENTINEL_OPERATOR_ID,
    operatorEmail: null,
    operatorName: null,
    authed,
    named: false,
  };
}
