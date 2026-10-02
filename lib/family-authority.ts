/**
 * Administrator-controlled families (2 Oct 2026).
 *
 * Parent/child relationships are created, corrected and removed by authorised
 * club administrators — the owner and a manager. A coach or admin role does not
 * get it by default, and a member or parent never does.
 *
 * A member may still add a child through the welcome flow, because that is how a
 * parent self-serves at signup and removing it would break onboarding. What
 * changed is the authority it carries: the link is born SUGGESTED
 * (`guardianConfirmedAt = null`), which `CONFIRMED_GUARDIAN` in
 * lib/guardianship.ts excludes from every parent-acts-for-child read. A
 * suggested link confers no access until an administrator confirms it on the
 * Family card. Before this, `CONFIRMED_BY("member")` let a parent grant
 * themselves confirmed guardian authority in a single request.
 *
 * Keep the rule here rather than inline in each route, so it cannot drift
 * between the routes that share it.
 */

/** The only roles that may create, reassign or remove a relationship. */
export const MAY_MUTATE_FAMILY = ["owner", "manager"] as const;

/**
 * The link columns for a relationship a member proposed about themselves.
 * Deliberately not `CONFIRMED_BY` — a member does not confirm their own
 * guardianship.
 */
export const SUGGESTED_BY_MEMBER = {
  guardianConfirmedAt: null,
  guardianSuggestedBy: "member",
} as const;

/**
 * What a parent may edit on a child an administrator has already assigned to
 * them. Approved dependent permissions only: nothing here changes who the
 * child belongs to, what kind of account it is, or which club it is in.
 */
export const DEPENDENT_EDITABLE_FIELDS = [
  "name",
  "dateOfBirth",
  "medicalConditions",
  "photoUrl",
] as const;

/**
 * Fields a self-service request may never carry. A member sending any of these
 * is attempting to grant themselves authority, so the request is refused rather
 * than quietly stripped — silence would hide an attempt worth seeing.
 */
export const FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET = [
  "parentMemberId",
  "accountType",
  "guardianConfirmedAt",
  "guardianSuggestedBy",
  "tenantId",
] as const;

export class FamilyAuthorityError extends Error {
  constructor() {
    super("Family relationships are managed by club staff.");
    this.name = "FamilyAuthorityError";
  }
}

/** Throws unless the role may change a relationship. */
export function assertMayMutateFamily(role: string | undefined | null): void {
  if (!role || !(MAY_MUTATE_FAMILY as readonly string[]).includes(role)) {
    throw new FamilyAuthorityError();
  }
}

/** True when the body carries a field a member must never set. */
export function carriesForbiddenFamilyField(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET.some((f) => keys.includes(f));
}

/**
 * Narrows a dependent-edit body to the allow-list. Unknown keys are dropped;
 * a caller that wants an attempt refused outright uses
 * `carriesForbiddenFamilyField` first.
 */
export function pickDependentFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  const src = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of DEPENDENT_EDITABLE_FIELDS) {
    if (f in src) out[f] = src[f];
  }
  return out;
}
