/**
 * Staff display name rules (8 Oct 2026, account-editing lane R). Shared by the
 * self-service profile route (/api/account/profile) and the operator owner
 * profile correction (/api/admin/customers/[id]/owner-profile), so the two
 * cannot accept different names.
 *
 * Trimmed, 1 to 100 characters (the staff create/edit limit), no control
 * characters or direction marks: the name is rendered in lists, the top bar
 * and audit labels.
 */
import { z } from "zod";

export const DISPLAY_NAME_MAX = 100;

/**
 * C0 and C1 controls (U+0000–001F, U+007F–009F), the line and paragraph
 * separators (U+2028, U+2029) and the bidirectional embedding/override and
 * isolate marks (U+202A–202E, U+2066–2069), which can make a name render as
 * something else in lists and audit labels (review D3, 8 Oct 2026).
 */
export const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(DISPLAY_NAME_MAX, `Use ${DISPLAY_NAME_MAX} characters or fewer`)
  .refine((v) => !FORBIDDEN_NAME_CHARS.test(v), "Remove line breaks, control characters and direction marks");
