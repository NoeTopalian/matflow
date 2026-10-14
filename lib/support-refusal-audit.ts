// Refused-attempt logging for support EDIT sessions (assurance plan G2, 14 Oct
// 2026). Lives apart from lib/support-session.ts on purpose: that module is
// imported by proxy.ts at the edge and must stay free of Prisma; this one is
// server-only (route handlers).
//
// What is recorded: an OPERATOR-plane row (tenantId null, entity = the
// operator's keyed digest, the pattern admin.* rows use) naming the target
// club, the scope, the route pattern and the REFUSED FIELD NAMES — never a
// submitted value, never a body. Owners' Activity is untouched: the
// functional review judged that refusal rows there would read as confusing
// noise; the operator plane is where overreach is reviewed.
//
// Edge-level route-allowlist refusals (proxy.ts) cannot write to the database
// and are NOT recorded here; that limit is stated in the release packet.
import { logAudit } from "@/lib/audit-log";
import { operatorIdDigest } from "@/lib/operator-auth";
import { isSupportSession } from "@/lib/support-session";

export const SUPPORT_REFUSAL_ACTION = "support.edit.refused";

export type SupportRefusal = {
  /** Route pattern, e.g. "PATCH /api/members/[id]" — never the concrete URL with ids. */
  route: string;
  /** Field NAMES the policy refused (from the response's refusedFields). */
  refusedFields: string[];
};

/**
 * Fire-and-forget: a failed audit write must never turn a refusal into a 500
 * (the refusal already happened). Resolves to void in every case.
 */
export async function recordSupportRefusal(session: unknown, refusal: SupportRefusal, req?: Request): Promise<void> {
  if (!isSupportSession(session)) return;
  const user = (session as { user?: { impersonatedBy?: string; tenantId?: string; supportScope?: unknown } }).user;
  const operatorId = user?.impersonatedBy;
  if (!operatorId) return;
  try {
    await logAudit({
      tenantId: null,
      action: SUPPORT_REFUSAL_ACTION,
      entityType: "Operator",
      entityId: operatorIdDigest(operatorId),
      metadata: {
        targetTenantId: user?.tenantId ?? null,
        scope: user?.supportScope === "edit" ? "edit" : "view",
        route: refusal.route,
        // Bounded and identifier-shaped: a hostile body cannot turn the row
        // into a multi-megabyte log line (security review M-3).
        refusedFields: refusal.refusedFields.slice(0, 20).map((f) => (/^[A-Za-z0-9_.$-]{1,64}$/.test(f) ? f : "<invalid>")),
      },
      actAsUserId: operatorId,
      req,
    });
  } catch (err) {
    console.error("[support-refusal-audit] refusal happened but its audit row could not be written", err);
  }
}

/** The refusedFields array from a refuseSupportEditFields response, without re-reading the body. */
export async function refusedFieldsOf(res: Response): Promise<string[]> {
  try {
    const source = typeof (res as { clone?: unknown }).clone === "function" ? res.clone() : res;
    const body = (await source.json()) as { refusedFields?: unknown };
    return Array.isArray(body.refusedFields) ? body.refusedFields.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
