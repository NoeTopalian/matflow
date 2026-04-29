"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Mail, Loader2 } from "lucide-react";

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

export default function FamilySection({ primaryColor, billingContactEmail, gymName }: Props) {
  const [children, setChildren] = useState<Child[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

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

      {/* No-children state: replaces "Add Child" with email-the-gym CTA (#8 + #15) */}
      {!loading && !error && children && children.length === 0 && (
        <div className="mx-4 mb-4 rounded-2xl border px-4 py-3" style={{ borderColor: "var(--member-border)", background: "var(--member-surface)" }}>
          <p className="text-gray-400 text-xs">
            To add a family member, contact{" "}
            {billingContactEmail ? (
              <a
                href={`mailto:${billingContactEmail}`}
                className="inline-flex items-center gap-1 font-medium"
                style={{ color: primaryColor }}
              >
                <Mail className="w-3 h-3" /> {billingContactEmail}
              </a>
            ) : (
              <span className="text-white">{gymName} front desk</span>
            )}
            .
          </p>
        </div>
      )}

      {/* Linked children list — whole row tappable, NO delete X (#4) */}
      {!loading && !error && children && children.length > 0 && (
        <>
          {children.map((c, i) => {
            const age = ageFrom(c.dateOfBirth);
            return (
              <button
                key={c.id}
                onClick={() => router.push(`/member/family/${c.id}`)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/2"
                style={{ borderTop: i === 0 ? "1px solid var(--member-border)" : "1px solid var(--member-border)" }}
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
            );
          })}

          <p className="text-gray-700 text-[10px] text-center px-4 py-3 border-t" style={{ borderColor: "var(--member-border)" }}>
            Belt updates managed by your coach · Need to add a sibling?{" "}
            {billingContactEmail ? (
              <a href={`mailto:${billingContactEmail}`} style={{ color: primaryColor }}>Email us</a>
            ) : (
              <>Ask the {gymName} front desk</>
            )}
          </p>
        </>
      )}
    </div>
  );
}
