/**
 * Turn an API error body of the shape every zod-validated route returns —
 * `{ error, details: parsed.error.flatten() }` — into one sentence that names
 * the field. RULES §2: "Invalid data" on its own tells the operator nothing
 * they can act on. Pure, no imports, safe in client components.
 */
// What a person calls the field, where its code name is not it.
const FIELD_LABELS: Record<string, string> = {
  amountPence: "Amount",
  pricePence: "Price",
  dateOfBirth: "Date of birth",
  paidAt: "Date paid",
  maxClassesPerWeek: "Classes per week",
};

function fieldLabel(field: string): string {
  if (FIELD_LABELS[field]) return FIELD_LABELS[field];
  const words = field.replace(/(Pence|Id)$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const pounds = (pence: number) =>
  "£" + (pence / 100).toLocaleString("en-GB", { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 });

/**
 * The validator's own defaults ("Too big: expected string to have <=100
 * characters") as a sentence a person can act on ("Name must be 100 characters
 * or fewer."), or null when the default is not one we recognise (verifier
 * lane 7, 30 Sep 2026: raw schema text reached four screens).
 */
function translateDefault(field: string, message: string): string | null {
  const label = fieldLabel(field);
  const money = /Pence$/.test(field);
  let m: RegExpMatchArray | null;
  if ((m = message.match(/^Too big: expected string to have <=(\d+) characters/))) return `${label} must be ${m[1]} characters or fewer.`;
  if ((m = message.match(/^Too small: expected string to have >=(\d+) characters/))) {
    return m[1] === "1" ? `${label} is required.` : `${label} must be at least ${m[1]} characters.`;
  }
  if ((m = message.match(/^Too big: expected number to be <=(\d+)/))) {
    const n = Number(m[1]);
    return money ? `${label} must be ${pounds(n)} or less.` : `${label} must be ${n} or less.`;
  }
  if ((m = message.match(/^Too small: expected number to be >=?(\d+)/))) {
    const n = Number(m[1]);
    return money ? `${label} must be at least ${pounds(n)}.` : `${label} must be at least ${n}.`;
  }
  if (/^Invalid email/i.test(message)) return "Enter a valid email address.";
  if (/received undefined$/.test(message) || /^Required$/.test(message)) return `${label} is required.`;
  return null;
}

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
  const writtenForPeople = (m: string) => /^[A-Z]/.test(m) && !/^(Too (big|small)|Invalid|Expected|Required|String must|Number must|Array must)\b/.test(m);
  const sentences = Object.entries(b.details?.fieldErrors ?? {}).flatMap(([field, msgs]) =>
    (Array.isArray(msgs) ? msgs : [msgs])
      .map((m) => String(m).trim())
      .filter(Boolean)
      .map((m) => (writtenForPeople(m) ? (/[.!?]$/.test(m) ? m : `${m}.`) : translateDefault(field, m))),
  );
  if (sentences.length > 0 && sentences.every((s): s is string => s !== null)) {
    return [...new Set(sentences)].join(" ");
  }
  const fields = Object.entries(b.details?.fieldErrors ?? {})
    .map(([field, msgs]) => `${field}: ${Array.isArray(msgs) ? String(msgs[0]) : String(msgs)}`)
    .join("; ");
  return fields ? `${base} — ${fields}` : base;
}
