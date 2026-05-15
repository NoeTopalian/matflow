import { randomBytes } from "crypto";

// Synthesised, unique-per-tenant email placeholder for kid Members.
//
// Kids never log in — they have `passwordHash: null` and are managed by their
// parent. But the Member table has a `@@unique([tenantId, email])` constraint,
// so creates need *some* email value. This helper produces one that:
//
//   - Never collides — 16-byte hex = 2^128 entropy
//   - Cannot land in a real inbox — `.local` is RFC-2606 reserved
//   - Is self-documenting — `no-login.matflow.local` makes the intent obvious
//     in audit logs, CSV exports, and DB dumps
//
// Used by both the staff create-member flow (POST /api/members) and the parent
// self-serve flow (POST /api/member/children). Keep this the single source —
// don't reintroduce a second format.
export function synthesiseKidEmail(): string {
  const id = randomBytes(16).toString("hex");
  return `kid-${id}@no-login.matflow.local`;
}
