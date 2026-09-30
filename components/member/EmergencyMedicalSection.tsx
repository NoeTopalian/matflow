"use client";

/**
 * Emergency contact + medical notes on /member/profile (verifier lane 2,
 * defect 4). The welcome wizard collected these once and nothing let a member
 * see or change them afterwards; the only other place they surfaced was the
 * waiver form, and only when missing.
 *
 * Reads GET /api/member/me and writes PATCH /api/member/me — the same fields
 * the wizard uses. Medical notes are shown through `medicalNotesText`, which
 * understands every stored shape (desk free text, the wizard's JSON list, an
 * empty list) and treats "None of the above" as nothing. On save they go back
 * as a list, one condition per line; an empty list is stored as null.
 *
 * States are honest (UI-RULES §7): a skeleton while loading, an error with a
 * retry when the read fails — never an empty "no contact" for an HTTP error —
 * and a failed save keeps the draft and says why.
 */
import { useCallback, useEffect, useState } from "react";
import { HeartPulse, Pencil, Phone, User, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { medicalNotesText } from "@/lib/medical-notes";
import { describeSaveFailure } from "@/lib/save-failure";

export type EmergencyContactValue = { name: string | null; phone: string | null; relation: string | null };

type Stored = EmergencyContactValue & { medical: string | null };
type Draft = { name: string; phone: string; relation: string; medical: string };

type MeResponse = {
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  emergencyContactRelation?: string | null;
  medicalConditions?: unknown;
};

const ACCENT_TINT = "color-mix(in srgb, var(--color-primary) 10%, transparent)";

export default function EmergencyMedicalSection({
  onSaved,
}: {
  /** Told the new contact after a save, so the page's waiver form sees it. */
  onSaved?: (contact: EmergencyContactValue) => void;
}) {
  const [status, setStatus] = useState<"loading" | "error" | "ready">("loading");
  const [stored, setStored] = useState<Stored>({ name: null, phone: null, relation: null, medical: null });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: "", phone: "", relation: "", medical: "" });
  const [contactError, setContactError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  // State is only set after the await, so the mount effect never sets state
  // synchronously; Retry flips back to "loading" itself.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/member/me");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const me = (await res.json()) as MeResponse;
      setStored({
        name: me.emergencyContactName?.trim() || null,
        phone: me.emergencyContactPhone?.trim() || null,
        relation: me.emergencyContactRelation?.trim() || null,
        medical: medicalNotesText(me.medicalConditions),
      });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function retry() {
    setStatus("loading");
    void load();
  }

  function startEdit() {
    setDraft({
      name: stored.name ?? "",
      phone: stored.phone ?? "",
      relation: stored.relation ?? "",
      // medicalNotesText joins list items with "; " — one per line to edit.
      medical: stored.medical ? stored.medical.split("; ").join("\n") : "",
    });
    setContactError(null);
    setSaveError(null);
    setSavedNote(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setContactError(null);
    setSaveError(null);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.name.trim();
    const phone = draft.phone.trim();
    const relation = draft.relation.trim();
    if (!name || !phone || !relation) {
      setContactError("Enter all three: their name, their phone number and how you know them.");
      return;
    }
    setContactError(null);
    const conditions = draft.medical.split("\n").map((l) => l.trim()).filter(Boolean);

    setSaving(true);
    setSaveError(null);
    let res: Response | null = null;
    try {
      res = await fetch("/api/member/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emergencyContactName: name,
          emergencyContactPhone: phone,
          emergencyContactRelation: relation,
          medicalConditions: conditions,
        }),
      });
    } catch {
      res = null;
    }
    if (!res) {
      setSaveError(describeSaveFailure(0, null, "Save").message);
      setSaving(false);
      return;
    }
    if (!res.ok) {
      const body: unknown = await res.json().catch(() => null);
      setSaveError(describeSaveFailure(res.status, body, "Save").message);
      setSaving(false);
      return;
    }
    const next: Stored = { name, phone, relation, medical: medicalNotesText(conditions) };
    setStored(next);
    setEditing(false);
    setSaving(false);
    setSavedNote(true);
    onSaved?.({ name, phone, relation });
  }

  const hasContact = !!(stored.name || stored.phone || stored.relation);

  return (
    <section
      aria-labelledby="emergency-medical-heading"
      className="rounded-2xl border overflow-hidden mb-4"
      style={{ borderColor: "var(--member-border)" }}
    >
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2
          id="emergency-medical-heading"
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: "var(--member-text-muted)" }}
        >
          Emergency &amp; medical
        </h2>
        {status === "ready" && !editing && (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={startEdit}
            aria-label="Edit emergency contact and medical notes"
            className="gap-1.5 rounded-lg px-2.5 text-xs font-semibold hover:bg-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]"
            style={{ color: "var(--color-primary)", background: ACCENT_TINT }}
          >
            <Pencil className="w-3 h-3" aria-hidden />
            Edit
          </Button>
        )}
      </div>

      {status === "loading" && (
        <div className="px-4 pb-4 space-y-3" aria-busy="true" aria-label="Loading emergency contact">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 rounded-lg animate-pulse" style={{ background: "var(--member-surface)" }} aria-hidden />
          ))}
        </div>
      )}

      {status === "error" && (
        <div role="alert" className="px-4 pb-4 flex items-center justify-between gap-3">
          <p className="text-sm flex-1" style={{ color: "var(--member-danger)" }}>
            Couldn&apos;t load your emergency contact and medical notes.
          </p>
          <Button
            type="button"
            variant="secondary"
            onClick={retry}
            className="shrink-0 min-h-11 rounded-xl"
          >
            Retry
          </Button>
        </div>
      )}

      {status === "ready" && !editing && (
        <>
          {hasContact ? (
            [
              { icon: User, label: "Emergency contact", value: stored.name ?? "—" },
              { icon: Phone, label: "Their phone", value: stored.phone ?? "—" },
              { icon: Users, label: "Relation", value: stored.relation ?? "—" },
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="flex items-center gap-3 px-4 py-3.5" style={{ borderTop: "1px solid var(--member-border)" }}>
                <Icon className="w-4 h-4 shrink-0" style={{ color: "var(--member-text-dim)" }} aria-hidden />
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5" style={{ color: "var(--member-text-muted)" }}>{label}</p>
                  <p className="text-sm truncate" style={{ color: "var(--member-text)" }}>{value}</p>
                </div>
              </div>
            ))
          ) : (
            <p className="px-4 py-3.5 text-sm" style={{ borderTop: "1px solid var(--member-border)", color: "var(--member-text-muted)" }}>
              No emergency contact on file. Add one so your gym knows who to call — you&apos;ll also need it to sign a waiver.
            </p>
          )}
          <div className="flex items-start gap-3 px-4 py-3.5" style={{ borderTop: "1px solid var(--member-border)" }}>
            <HeartPulse className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--member-text-dim)" }} aria-hidden />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-medium uppercase tracking-wider mb-0.5" style={{ color: "var(--member-text-muted)" }}>Medical notes</p>
              <p className="text-sm whitespace-pre-line" style={{ color: stored.medical ? "var(--member-text)" : "var(--member-text-muted)" }}>
                {stored.medical ?? "None recorded"}
              </p>
            </div>
          </div>
          {savedNote && (
            <p role="status" className="px-4 pb-3 text-sm font-medium" style={{ color: "var(--member-success)" }}>
              Saved
            </p>
          )}
          <div className="pb-1.5" />
        </>
      )}

      {status === "ready" && editing && (
        <form onSubmit={save} noValidate>
          <p className="px-4 pb-2 text-xs" style={{ color: "var(--member-text-muted)" }}>
            Your gym calls this person if something happens to you in class. Name, phone and relation are all needed.
          </p>
          {(
            [
              { key: "name" as const, label: "Their name", type: "text", autoComplete: "off" },
              { key: "phone" as const, label: "Their phone", type: "tel", autoComplete: "off" },
              { key: "relation" as const, label: "Relation (e.g. partner, parent)", type: "text", autoComplete: "off" },
            ]
          ).map(({ key, label, type, autoComplete }) => (
            <label key={key} className="block px-4 py-3" style={{ borderTop: "1px solid var(--member-border)" }}>
              <span className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: "var(--member-text-muted)" }}>{label}</span>
              <input
                type={type}
                autoComplete={autoComplete}
                value={draft[key]}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [key]: e.target.value }));
                  if (contactError) setContactError(null);
                }}
                aria-invalid={!!contactError && !draft[key].trim()}
                aria-describedby={contactError ? "emergency-contact-error" : undefined}
                className="w-full min-h-11 rounded-lg px-3 text-sm outline-none border"
                style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "var(--member-text)" }}
              />
            </label>
          ))}
          {contactError && (
            <p id="emergency-contact-error" className="px-4 pb-2 text-xs" style={{ color: "var(--member-danger)" }}>
              {contactError}
            </p>
          )}
          <label className="block px-4 py-3" style={{ borderTop: "1px solid var(--member-border)" }}>
            <span className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: "var(--member-text-muted)" }}>
              Medical notes (optional)
            </span>
            <textarea
              value={draft.medical}
              onChange={(e) => setDraft((d) => ({ ...d, medical: e.target.value }))}
              rows={3}
              aria-describedby="medical-notes-hint"
              className="w-full min-h-11 rounded-lg px-3 py-2.5 text-sm outline-none border resize-y"
              style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "var(--member-text)" }}
            />
            <span id="medical-notes-hint" className="block text-[11px] mt-1" style={{ color: "var(--member-text-muted)" }}>
              One condition per line — asthma, allergies, past injuries. Leave empty if there is nothing.
            </span>
          </label>
          {saveError && (
            <p role="alert" className="px-4 pb-1 text-sm" style={{ color: "var(--member-danger)" }}>
              {saveError}
            </p>
          )}
          <div className="mt-2 flex items-center justify-end gap-2 px-4 pb-4">
            <Button
              type="button"
              variant="ghost"
              onClick={cancelEdit}
              className="min-h-11 rounded-xl border hover:bg-[color-mix(in_srgb,var(--member-text-muted)_10%,transparent)]"
              style={{ color: "var(--member-text-muted)", borderColor: "var(--member-border)" }}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={saving} className="min-h-11 rounded-xl font-semibold">
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
