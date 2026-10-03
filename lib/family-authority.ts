/**
 * Administrator-controlled families (2–3 Oct 2026).
 *
 * Changing WHO a child belongs to is an administrator's job — the owner or a
 * manager. A coach or admin does not get it by default, and a member never does.
 *
 * The line this draws is between CREATING a new child and CLAIMING an existing
 * person. A parent adding their own child through the welcome flow creates a row
 * with no history, no money and no prior access, so that link is confirmed on
 * creation; it grants nothing that existed before. Claiming someone who already
 * exists is the real risk, and that is POST /api/members/[id]/link-child
 * (owner-only) plus the links an import infers from a shared email or emergency
 * contact — those stay suggested (`guardianConfirmedAt` null) until staff
 * confirm them on the Family card, which `CONFIRMED_GUARDIAN` in
 * lib/guardianship.ts enforces on every parent-acts-for-child read.
 *
 * What a member still may never do: remove a child, reparent themselves, or set
 * a confirmation column by hand. Those are the guards below.
 */
/** The only roles that may create, reassign or remove a relationship. */
export const MAY_MUTATE_FAMILY = ["owner", "manager"] as const;

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
 * Fields a member must never set **on their own record**. Deliberately narrow:
 * only the columns that decide guardian authority. A member sending one of
 * these is trying to reparent themselves or confirm their own guardianship, and
 * no legitimate client sends them, so the request is refused rather than quietly
 * stripped — silence would hide the attempt.
 *
 * `accountType` is NOT here. app/member/home/page.tsx PATCHes
 * `{ accountType: "parent" }` as the supported way a member declares they have
 * children, and refusing it broke that flow (caught by lf-1 J52, 2 Oct 2026).
 * Declaring yourself a parent grants no authority over any child — only a
 * confirmed link does — so it is safe self-service.
 *
 * `tenantId` is not here either: the route derives the tenant from the session
 * and has always ignored a body value, which lf-1 J52 pins. Refusing it would
 * change a passing contract for no gain in safety.
 */
export const FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET = [
  "parentMemberId",
  "guardianConfirmedAt",
  "guardianSuggestedBy",
] as const;

/**
 * The same, plus the fields a parent must never set on a CHILD's record. A
 * child's account type and club are staff territory even though a member may
 * set their own account type.
 */
export const CHILD_FIELDS_MEMBERS_MAY_NEVER_SET = [
  ...FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET,
  "accountType",
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

/**
 * True when the body carries a field the caller must never set. `fields`
 * defaults to the self-record list; the child routes pass
 * CHILD_FIELDS_MEMBERS_MAY_NEVER_SET.
 */
export function carriesForbiddenFamilyField(
  body: unknown,
  fields: readonly string[] = FAMILY_FIELDS_MEMBERS_MAY_NEVER_SET,
): boolean {
  if (!body || typeof body !== "object") return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return fields.some((f) => keys.includes(f));
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
