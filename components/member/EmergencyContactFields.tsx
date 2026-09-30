"use client";

/**
 * The emergency-contact trio every waiver signature needs.
 *
 * POST /api/waiver/sign and /api/waiver/sign-for-child both refuse until the
 * SIGNER (the member, or the parent signing for a child) has a name, phone and
 * relation on file, and neither signing form used to offer the fields — two
 * dead ends (F-21 for the member, the Wave 1 re-drive of 30 Sep 2026 for the
 * parent). This hook works out whether the signer's contact is incomplete and,
 * if so, the form renders the fieldset and saves it through PATCH
 * /api/member/me (the same write the welcome wizard uses) before signing.
 */
import { useEffect, useState } from "react";

export type EmergencyContact = { name: string | null; phone: string | null; relation: string | null };

function complete(c: EmergencyContact | undefined | null): boolean {
  return !!(c?.name?.trim() && c.phone?.trim() && c.relation?.trim());
}

/**
 * `initial` given → decide from it. Omitted → read the signer's own record from
 * /api/member/me. If that read fails the fields are shown, because asking for a
 * contact that turns out to be on file costs a few seconds while not asking
 * for a missing one is the dead end this exists to remove.
 */
export function useEmergencyContactGate(initial?: EmergencyContact) {
  const [ask, setAsk] = useState<boolean | null>(initial ? !complete(initial) : null);
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [relation, setRelation] = useState(initial?.relation ?? "");

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/member/me");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const me = (await res.json()) as { emergencyContactName?: string | null; emergencyContactPhone?: string | null; emergencyContactRelation?: string | null };
        if (cancelled) return;
        const c = { name: me.emergencyContactName ?? null, phone: me.emergencyContactPhone ?? null, relation: me.emergencyContactRelation ?? null };
        setName(c.name ?? ""); setPhone(c.phone ?? ""); setRelation(c.relation ?? "");
        setAsk(!complete(c));
      } catch {
        if (!cancelled) setAsk(true);
      }
    })();
    return () => { cancelled = true; };
    // Decided once per mount from what the server had on file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = ask === false || (ask === true && !!name.trim() && !!phone.trim() && !!relation.trim());

  /** Saves the typed contact when it was asked for. Returns an error sentence, or null. */
  async function save(): Promise<string | null> {
    if (!ask) return null;
    const res = await fetch("/api/member/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emergencyContactName: name.trim(),
        emergencyContactPhone: phone.trim(),
        emergencyContactRelation: relation.trim(),
      }),
    }).catch(() => null);
    if (!res) return "Couldn't reach MatFlow to save your emergency contact. Check your signal and try again.";
    if (!res.ok) {
      const msg = await res.json().then((j: { error?: string }) => j?.error).catch(() => undefined);
      return msg ?? "Couldn't save your emergency contact. Tap to retry.";
    }
    return null;
  }

  return { ask, ready, save, fields: { name, setName, phone, setPhone, relation, setRelation } };
}

export function EmergencyContactFieldset({
  gate,
  idPrefix,
  legend = "Emergency contact — your gym needs someone to call before you train *",
}: {
  gate: ReturnType<typeof useEmergencyContactGate>;
  idPrefix: string;
  legend?: string;
}) {
  if (!gate.ask) return null;
  const f = gate.fields;
  const rows = [
    { id: `${idPrefix}-ec-name`, label: "Their name", value: f.name, set: f.setName, type: "text", max: 120 },
    { id: `${idPrefix}-ec-phone`, label: "Their phone", value: f.phone, set: f.setPhone, type: "tel", max: 30 },
    { id: `${idPrefix}-ec-relation`, label: "How you know them (e.g. partner, parent)", value: f.relation, set: f.setRelation, type: "text", max: 60 },
  ] as const;
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-medium mb-1.5" style={{ color: "var(--member-text-muted)" }}>
        {legend}
      </legend>
      {rows.map((r) => (
        <div key={r.id}>
          <label htmlFor={r.id} className="text-xs block mb-1" style={{ color: "var(--member-text-muted)" }}>
            {r.label}
          </label>
          <input
            id={r.id}
            type={r.type}
            autoComplete="off"
            maxLength={r.max}
            value={r.value}
            onChange={(e) => r.set(e.target.value)}
            className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
            style={{ background: "var(--member-elevated)", borderColor: "var(--member-border)", color: "var(--member-text)" }}
          />
        </div>
      ))}
    </fieldset>
  );
}
