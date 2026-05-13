"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Mail, Loader2, Plus, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import EditChildModal, { type EditableChild } from "@/components/member/EditChildModal";

// For kid Members, the waiver is signed by parent/guardian via the supervised
// flow (Sprint 2). Kids cannot self-sign — they have no login.
type Child = {
  id: string;
  name: string;
  dateOfBirth: string | null;
  accountType: string;
  waiverAccepted: boolean;
  belt: { name: string; color: string; stripes: number } | null;
  totalClasses: number;
};

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function ageFrom(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

interface Props {
  primaryColor: string;
  billingContactEmail: string | null;
  gymName: string;
}

// Sane defaults for a freshly-created kid row before the next GET refresh —
// the parent doesn't need to wait for a round-trip to see their new child
// in the list. Belt + totalClasses appear as soon as the gym actually
// records something for them.
function newChildDefaults(): Omit<Child, "id" | "name" | "dateOfBirth"> {
  return {
    accountType: "kids",
    waiverAccepted: false,
    belt: null,
    totalClasses: 0,
  };
}

export default function FamilySection({ primaryColor, billingContactEmail, gymName }: Props) {
  const [children, setChildren] = useState<Child[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // null = closed; { mode: "create" } = create; { mode: "edit", kid } = edit
  const [modal, setModal] = useState<
    | null
    | { mode: "create" }
    | { mode: "edit"; kid: EditableChild }
  >(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const router = useRouter();

  async function handleRemove(id: string) {
    if (removingId) return;
    setRemovingId(id);
    try {
      const res = await fetch(`/api/member/children/${id}`, { method: "DELETE" });
      if (res.ok) {
        setChildren((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
      } else {
        // Surface error — confirm so user sees feedback without an extra toast lib
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        alert(data.error ?? "Couldn't remove child. Try again.");
      }
    } finally {
      setRemovingId(null);
      setMenuOpenId(null);
    }
  }

  function handleSaved(saved: EditableChild) {
    setChildren((prev) => {
      if (!prev) return [{ ...newChildDefaults(), ...saved }];
      const existing = prev.find((c) => c.id === saved.id);
      if (existing) {
        return prev
          .map((c) => (c.id === saved.id ? { ...c, name: saved.name, dateOfBirth: saved.dateOfBirth } : c))
          .sort((a, b) => a.name.localeCompare(b.name));
      }
      return [...prev, { ...newChildDefaults(), ...saved }].sort((a, b) => a.name.localeCompare(b.name));
    });
    setModal(null);
  }

  useEffect(() => {
    fetch("/api/member/me/children")
      .then((r) => r.ok ? r.json() : null)
      .then((data: Child[] | null) => {
        if (Array.isArray(data)) setChildren(data);
        else setError("Couldn't load family — tap to retry");
      })
      .catch(() => setError("Couldn't load family — tap to retry"))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="rounded-2xl border overflow-hidden mb-5" style={{ borderColor: "var(--member-border)" }}>
      <div className="px-4 pt-4 pb-3">
        <p className="text-white font-semibold text-sm">My Family</p>
        <p className="text-gray-500 text-xs mt-0.5">Tap a child to see their progress and attendance</p>
      </div>

      {loading && (
        <div className="flex items-center gap-2 px-4 pb-4 text-gray-500 text-xs">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      )}

      {error && !loading && (
        <button
          onClick={() => { setLoading(true); setError(null); fetch("/api/member/me/children").then((r) => r.ok ? r.json() : null).then((d) => Array.isArray(d) ? setChildren(d) : setError("Couldn't load — tap to retry")).finally(() => setLoading(false)); }}
          className="px-4 pb-4 text-red-400 text-xs"
        >
          {error}
        </button>
      )}

      {/* Empty state: parent can self-serve directly via the modal. The
          "contact gym" copy is kept as a secondary tip in case the parent
          would rather have staff handle it — but the primary action is now
          in-app. */}
      {!loading && !error && children && children.length === 0 && (
        <div className="mx-4 mb-4 space-y-3">
          <button
            onClick={() => setModal({ mode: "create" })}
            className="w-full rounded-2xl border-2 border-dashed py-4 flex items-center justify-center gap-2 text-sm font-semibold transition-all"
            style={{ borderColor: hex(primaryColor, 0.4), color: primaryColor, background: hex(primaryColor, 0.05) }}
          >
            <Plus className="w-4 h-4" />
            Add a child
          </button>
          <p className="text-gray-600 text-[11px] text-center">
            Or contact{" "}
            {billingContactEmail ? (
              <a href={`mailto:${billingContactEmail}`} style={{ color: primaryColor }}>
                {billingContactEmail}
              </a>
            ) : (
              <span className="text-gray-400">{gymName} front desk</span>
            )}
            .
          </p>
        </div>
      )}

      {/* Linked children list — row is tappable for navigation; "..." menu
          handles edit + remove. The menu opens inline (no portal) and
          closes when the user picks an option, taps the row, or taps "..."
          again. */}
      {!loading && !error && children && children.length > 0 && (
        <>
          {children.map((c, i) => {
            const age = ageFrom(c.dateOfBirth);
            const isMenuOpen = menuOpenId === c.id;
            return (
              <div
                key={c.id}
                className="relative flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-white/2"
                style={{ borderTop: i === 0 ? "1px solid var(--member-border)" : "1px solid var(--member-border)" }}
              >
                <button
                  onClick={() => { setMenuOpenId(null); router.push(`/member/family/${c.id}`); }}
                  className="flex flex-1 items-center gap-3 text-left min-w-0"
                  aria-label={`View ${c.name}'s profile`}
                >
                  <div
                    className="w-10 h-10 rounded-2xl flex items-center justify-center text-white text-xs font-bold shrink-0"
                    style={{ background: `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.6)})` }}
                  >
                    {c.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-white text-sm font-semibold truncate">{c.name}</p>
                      {age !== null && <span className="text-gray-600 text-xs shrink-0">Age {age}</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {c.belt ? (
                        <>
                          <div className="w-5 h-2 rounded-sm" style={{ background: c.belt.color, border: "1px solid var(--member-text-dim)" }} />
                          <span className="text-gray-500 text-xs">{c.belt.name} · {c.belt.stripes} stripe{c.belt.stripes !== 1 ? "s" : ""}</span>
                        </>
                      ) : (
                        <span className="text-gray-600 text-xs">No belt yet</span>
                      )}
                      <span className="text-gray-600 text-xs">· {c.totalClasses} classes</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-gray-600 shrink-0" />
                </button>

                {/* Row action menu */}
                <button
                  onClick={() => setMenuOpenId(isMenuOpen ? null : c.id)}
                  aria-label={`Actions for ${c.name}`}
                  aria-expanded={isMenuOpen}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-gray-500 shrink-0"
                  style={{ background: "var(--member-surface)" }}
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>

                {isMenuOpen && (
                  <div
                    className="absolute right-3 top-12 z-10 rounded-xl shadow-lg overflow-hidden w-44"
                    style={{ background: "var(--member-elevated)", border: "1px solid var(--member-elevated-border)" }}
                  >
                    <button
                      onClick={() => {
                        setMenuOpenId(null);
                        setModal({ mode: "edit", kid: { id: c.id, name: c.name, dateOfBirth: c.dateOfBirth } });
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-white text-left hover:bg-white/5"
                    >
                      <Pencil className="w-3.5 h-3.5 text-gray-400" /> Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${c.name}? Their attendance history and any photos will be deleted too.`)) {
                          void handleRemove(c.id);
                        }
                      }}
                      disabled={removingId === c.id}
                      className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-red-400 text-left hover:bg-red-500/10 disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> {removingId === c.id ? "Removing…" : "Remove"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          <div className="px-4 py-3 border-t" style={{ borderColor: "var(--member-border)" }}>
            <button
              onClick={() => setModal({ mode: "create" })}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium"
              style={{ background: hex(primaryColor, 0.1), color: primaryColor, border: `1px solid ${hex(primaryColor, 0.25)}` }}
            >
              <Plus className="w-3.5 h-3.5" /> Add another child
            </button>
            <p className="text-gray-700 text-[10px] text-center mt-2">
              Belt updates managed by your coach
              {billingContactEmail && (
                <>
                  {" · "}
                  <a href={`mailto:${billingContactEmail}`} style={{ color: primaryColor }}>
                    <Mail className="w-2.5 h-2.5 inline -mt-0.5" /> Email us
                  </a>
                </>
              )}
              {!billingContactEmail && <> · or ask {gymName} front desk</>}
            </p>
          </div>
        </>
      )}

      {modal && (
        <EditChildModal
          primaryColor={primaryColor}
          kid={modal.mode === "edit" ? modal.kid : null}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
