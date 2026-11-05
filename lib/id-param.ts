/**
 * A record id taken from a query string (`?instance=`, `?classId=`,
 * `?paymentId=`). Ids here are cuids — letters and digits only — so anything
 * else is not an id and is dropped before it reaches a query: a repeated
 * param (an array), an empty string, or a pasted fragment.
 */
const ID_PARAM = /^[a-z0-9]{1,50}$/i;

export function parseIdParam(raw: unknown): string | null {
  return typeof raw === "string" && ID_PARAM.test(raw) ? raw : null;
}
