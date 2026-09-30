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
  // A route that wrote its own sentence for people ("Date paid can't be in the
  // future") should be shown that sentence alone — not "Invalid data — paidAt:
  // …", which leaks the field's code name (verifier lane 4, 30 Sep 2026). The
  // validator's own defaults ("Too big: …", "Invalid …") keep the field name,
  // because on their own they do not say which field.
  const messages = Object.values(b.details?.fieldErrors ?? {})
    .flatMap((m) => (Array.isArray(m) ? m : [m]))
    .map((m) => String(m).trim())
    .filter(Boolean);
  const writtenForPeople = (m: string) => /^[A-Z]/.test(m) && !/^(Too (big|small)|Invalid|Expected|Required|String must|Number must|Array must)\b/.test(m);
  if (messages.length > 0 && messages.every(writtenForPeople)) {
    return [...new Set(messages)].map((m) => (/[.!?]$/.test(m) ? m : `${m}.`)).join(" ");
  }
  const fields = Object.entries(b.details?.fieldErrors ?? {})
    .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? String(msgs[0]) : String(msgs)}`)
    .join("; ");
  return fields ? `${base} — ${fields}` : base;
}
