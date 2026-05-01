"use client";

import { useState } from "react";
import Link from "next/link";
import { Users, UserPlus, Unlink, Loader2, ChevronRight } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

export type FamilyChildSummary = {
  id: string;
  name: string;
  accountType: string | null;
  dateOfBirth: string | null;
  waiverAccepted: boolean;
};

export type FamilyParentSummary = {
  id: string;
  name: string;
};

export type LinkableMember = {
  id: string;
  name: string;
  email: string;
};

interface Props {
  memberId: string;
  memberName: string;
  hasKidsHint: boolean;
  parent: FamilyParentSummary | null;
  initialChildren: FamilyChildSummary[];
  primaryColor: string;
  role: string;
}

export default function OwnerFamilyManagement({
  memberId,
  memberName,
  hasKidsHint,
  parent,
  initialChildren,
  primaryColor,
  role,
}: Props) {
  const { toast } = useToast();
  const [children, setChildren] = useState<FamilyChildSummary[]>(initialChildren);
  const [linkOpen, setLinkOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const isOwner = role === "owner";

  async function unlinkChild(childId: string) {
    if (!confirm("Unlink this child? The child profile remains — only the link is removed.")) return;
    setBusy(`unlink:${childId}`);
    try {
      const res = await fetch(`/api/members/${memberId}/unlink-child`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childMemberId: childId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error ?? "Failed to unlink", "error");
        return;
      }
      setChildren((prev) => prev.filter((c) => c.id !== childId));
      toast("Child unlinked", "success");
    } finally {
      setBusy(null);
    }
  }

  async function onLinked(child: FamilyChildSummary) {
    setChildren((prev) => [...prev, child]);
    setLinkOpen(false);
  }

  async function onAdded(child: FamilyChildSummary) {
    setChildren((prev) => [...prev, child]);
    setAddOpen(false);
  }

  return (
    <div className="rounded-2xl border p-5 mb-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4" style={{ color: primaryColor }} />
          <h3 className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Family</h3>
          {hasKidsHint && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
              has kids
            </span>
          )}
        </div>
        {isOwner && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLinkOpen(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
            >
              Link existing
            </button>
            <button
              onClick={() => setAddOpen(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-white inline-flex items-center gap-1"
              style={{ background: primaryColor }}
            >
              <UserPlus className="w-3 h-3" /> Add child
            </button>
          </div>
        )}
      </div>

      {parent && (
        <div className="mb-3 px-3 py-2 rounded-lg flex items-center justify-between" style={{ background: "rgba(255,255,255,0.03)" }}>
          <div>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--tx-4)" }}>Parent</p>
            <Link
              href={`/dashboard/members/${parent.id}`}
              className="text-sm font-medium hover:underline"
              style={{ color: primaryColor }}
            >
              {parent.name}
            </Link>
          </div>
          <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: "rgba(59,130,246,0.15)", color: "#3b82f6" }}>
            sub-account
          </span>
        </div>
      )}

      {children.length === 0 && !parent ? (
        <p className="text-xs" style={{ color: "var(--tx-4)" }}>
          No linked children yet. {isOwner ? "Use Link existing or Add child to get started." : ""}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {children.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg"
              style={{ background: "rgba(255,255,255,0.025)" }}
            >
              <Link
                href={c.waiverAccepted ? `/dashboard/members/${c.id}` : `/dashboard/members/${c.id}/waiver`}
                className="flex items-center gap-2 flex-1 min-w-0"
              >
                <span className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{c.name}</span>
                {c.accountType === "kids" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                    kids
                  </span>
                )}
                {!c.waiverAccepted && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                    waiver missing
                  </span>
                )}
                <ChevronRight className="w-3.5 h-3.5 ml-auto" style={{ color: "var(--tx-4)" }} />
              </Link>
              {isOwner && (
                <button
                  onClick={() => unlinkChild(c.id)}
                  disabled={busy === `unlink:${c.id}`}
                  className="text-[11px] px-2 py-1 rounded-md inline-flex items-center gap-1 disabled:opacity-50"
                  style={{ color: "#ef4444" }}
                  aria-label={`Unlink ${c.name}`}
                >
                  {busy === `unlink:${c.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Unlink className="w-3 h-3" />}
                  Unlink
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {linkOpen && (
        <LinkExistingModal
          parentId={memberId}
          onClose={() => setLinkOpen(false)}
          onLinked={onLinked}
          primaryColor={primaryColor}
        />
      )}
      {addOpen && (
        <AddChildModal
          parentId={memberId}
          parentName={memberName}
          onClose={() => setAddOpen(false)}
          onAdded={onAdded}
          primaryColor={primaryColor}
        />
      )}
    </div>
  );
}

// ─── Link existing member as child ────────────────────────────────────────────

function LinkExistingModal({
  parentId,
  onClose,
  onLinked,
  primaryColor,
}: {
  parentId: string;
  onClose: () => void;
  onLinked: (child: FamilyChildSummary) => void;
  primaryColor: string;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LinkableMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  async function search() {
    setLoading(true);
    try {
      const res = await fetch("/api/members?take=200");
      const data = await res.json();
      const list: LinkableMember[] = (data.members ?? []).filter(
        (m: { id: string; parentMemberId: string | null; passwordHash?: string | null; name: string; email: string }) =>
          m.id !== parentId && m.parentMemberId === null,
      );
      const filtered = query.trim()
        ? list.filter((m) => m.name.toLowerCase().includes(query.toLowerCase()) || m.email.toLowerCase().includes(query.toLowerCase()))
        : list;
      setResults(filtered.slice(0, 50));
    } finally {
      setLoading(false);
    }
  }

  async function link(child: LinkableMember) {
    setLinking(child.id);
    try {
      const res = await fetch(`/api/members/${parentId}/link-child`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childMemberId: child.id }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error ?? "Failed to link", "error");
        return;
      }
      toast(`${child.name} linked`, "success");
      onLinked({ id: child.id, name: child.name, accountType: null, dateOfBirth: null, waiverAccepted: false });
    } finally {
      setLinking(null);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-2xl border p-5 max-h-[80vh] overflow-y-auto" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
        <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--tx-1)" }}>Link existing member as child</h3>
        <p className="text-xs mb-3" style={{ color: "var(--tx-4)" }}>
          Only members without a password (kid sub-accounts) and not yet linked are eligible.
        </p>
        <div className="flex gap-2 mb-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search name or email"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none border"
            style={{ background: "rgba(0,0,0,0.2)", color: "white", borderColor: "var(--bd-default)" }}
          />
          <button
            onClick={search}
            disabled={loading}
            className="text-xs font-semibold px-3 py-2 rounded-lg text-white"
            style={{ background: primaryColor }}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Search"}
          </button>
        </div>
        {results.length === 0 ? (
          <p className="text-xs text-center py-6" style={{ color: "var(--tx-4)" }}>
            {loading ? "Searching…" : "Tap Search to find candidates."}
          </p>
        ) : (
          <ul className="space-y-1">
            {results.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.03)" }}>
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: "var(--tx-1)" }}>{r.name}</p>
                  <p className="text-[10px] truncate" style={{ color: "var(--tx-4)" }}>{r.email}</p>
                </div>
                <button
                  onClick={() => link(r)}
                  disabled={linking === r.id}
                  className="text-[11px] px-2 py-1 rounded-md text-white"
                  style={{ background: primaryColor }}
                >
                  {linking === r.id ? <Loader2 className="w-3 h-3 animate-spin" /> : "Link"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={onClose} className="mt-4 text-xs text-gray-500 hover:text-white">Cancel</button>
      </div>
    </>
  );
}

// ─── Create new kid sub-account ───────────────────────────────────────────────

function AddChildModal({
  parentId,
  parentName,
  onClose,
  onAdded,
  primaryColor,
}: {
  parentId: string;
  parentName: string;
  onClose: () => void;
  onAdded: (child: FamilyChildSummary) => void;
  primaryColor: string;
}) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [dob, setDob] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !dob) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          accountType: "kids",
          parentMemberId: parentId,
          dateOfBirth: dob,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "Failed to create child", "error");
        return;
      }
      toast(`${name.trim()} added`, "success");
      onAdded({
        id: data.id,
        name: data.name,
        accountType: data.accountType ?? "kids",
        dateOfBirth: data.dateOfBirth ?? dob,
        waiverAccepted: false,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md rounded-2xl border p-5" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
        <h3 className="text-sm font-semibold mb-1" style={{ color: "var(--tx-1)" }}>Add child to {parentName}</h3>
        <p className="text-xs mb-4" style={{ color: "var(--tx-4)" }}>
          The child cannot log in. Use the supervised waiver flow to collect a signature.
        </p>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--tx-4)" }}>Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Child's full name"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none border"
              style={{ background: "rgba(0,0,0,0.2)", color: "white", borderColor: "var(--bd-default)" }}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--tx-4)" }}>Date of birth *</label>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg text-sm outline-none border"
              style={{ background: "rgba(0,0,0,0.2)", color: "white", borderColor: "var(--bd-default)" }}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-3 py-2 rounded-lg text-sm border"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !dob}
              className="flex-1 px-3 py-2 rounded-lg text-sm text-white font-semibold disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {submitting ? <Loader2 className="w-3 h-3 animate-spin inline" /> : "Add child"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
