/**
 * A record id taken from a query string (`?instance=`, `?classId=`,
 * `?paymentId=`). Most ids are cuids, but seeded data writes readable ones
 * ("seed-…-AdvancedNoGi", "inst-…-2026-11-04-19:00"), so letters, digits,
 * `_`, `-` and `:` are allowed. Anything else is not an id and is dropped
 * before it reaches a query: an empty string, a pasted fragment, or — on a
 * server page, where a repeated param arrives as an array — a repeat.
 * (`URLSearchParams.get` on the client returns the first of a repeat.)
 * Queries are parameterised; this is a sanity check, not the injection defence.
 */
const ID_PARAM = /^[A-Za-z0-9_:-]{1,100}$/;

export function parseIdParam(raw: unknown): string | null {
  return typeof raw === "string" && ID_PARAM.test(raw) ? raw : null;
}
