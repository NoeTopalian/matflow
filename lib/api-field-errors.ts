/**
 * Turn an API error body of the shape every zod-validated route returns —
 * `{ error, details: parsed.error.flatten() }` — into one sentence that names
 * the field. RULES §2: "Invalid data" on its own tells the operator nothing
 * they can act on. Pure, no imports, safe in client components.
 */
export function describeApiError(body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    details?: { fieldErrors?: Record<string, unknown> };
  };
  const base = typeof b.error === "string" && b.error ? b.error : "Something went wrong";
  const fields = Object.entries(b.details?.fieldErrors ?? {})
    .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? String(msgs[0]) : String(msgs)}`)
    .join("; ");
  return fields ? `${base} — ${fields}` : base;
}
