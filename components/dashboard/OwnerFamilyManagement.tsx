"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { Users, UserPlus, Unlink, Loader2, ChevronRight } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog } from "@/components/ui/dialog";

export type FamilyChildSummary = {
  id: string;
  name: string;
  accountType: string | null;
  dateOfBirth: string | null;
  waiverAccepted: boolean;
  paymentStatus: string | null;
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
  // §5.4: replaces the bare window.confirm() that used to gate the unlink.
  const [unlinkTarget, setUnlinkTarget] = useState<FamilyChildSummary | null>(null);

  const isOwner = role === "owner";

  async function unlinkChild(childId: string) {
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
      setUnlinkTarget(null);
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
    // §4a.5: the panel background was rgba(255,255,255,0.025) — invisible on
    // the light staff shell, so it read as loose text on the page. Card now.
    <Card className="mb-4">
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
        <div className="mb-3 px-3 py-2 rounded-lg flex items-center justify-between" style={{ background: "var(--sf-2)" }}>
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
          {children.map((c) => {
            const age = c.dateOfBirth
              ? (() => {
                  const birth = new Date(c.dateOfBirth);
                  const now = new Date();
                  let a = now.getFullYear() - birth.getFullYear();
                  const m = now.getMonth() - birth.getMonth();
                  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) a--;
                  return a;
                })()
              : null;
            const pmeta = (() => {
              const s = (c.paymentStatus ?? "").toLowerCase();
              if (s === "paid") return { label: "Paid", color: "#22c55e", bg: "rgba(34,197,94,0.12)" };
              if (s === "overdue") return { label: "Overdue", color: "#f97316", bg: "rgba(249,115,22,0.14)" };
              if (s === "pending") return { label: "Pending", color: "#38bdf8", bg: "rgba(56,189,248,0.13)" };
              if (s === "free") return { label: "Free", color: "#94a3b8", bg: "rgba(148,163,184,0.12)" };
              return null;
            })();

            return (
              <li
                key={c.id}
                className="flex items-center justify-between gap-2 rounded-[var(--r-sm)] px-3 py-2"
                style={{ background: "var(--sf-2)" }}
              >
                <Link
                  href={`/dashboard/members/${c.id}`}
                  className="flex items-center gap-2 flex-1 min-w-0"
                >
                  <span className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{c.name}</span>
                  {c.accountType && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full capitalize shrink-0"
                      style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
                    >
                      {c.accountType}
                    </span>
                  )}
                  {age !== null && (
                    <span className="text-[10px] shrink-0" style={{ color: "var(--tx-4)" }}>
                      age {age}
                    </span>
                  )}
                  {pmeta && (
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                      style={{ background: pmeta.bg, color: pmeta.color }}
                    >
                      {pmeta.label}
                    </span>
                  )}
                  {!c.waiverAccepted && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}>
                      waiver missing
                    </span>
                  )}
                  <ChevronRight className="w-3.5 h-3.5 ml-auto shrink-0" style={{ color: "var(--tx-4)" }} />
                </Link>
                {isOwner && (
                  <button
                    onClick={() => setUnlinkTarget(c)}
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
            );
          })}
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
        />
      )}

      {/* §5.4: the unlink used to be gated by window.confirm(). */}
      <ConfirmDialog
        open={unlinkTarget !== null}
        onClose={() => setUnlinkTarget(null)}
        onConfirm={() => {
          if (unlinkTarget) return unlinkChild(unlinkTarget.id);
        }}
        title={unlinkTarget ? `Unlink ${unlinkTarget.name}?` : "Unlink child"}
        description="The child profile remains — only the link to this parent is removed."
        confirmLabel="Unlink child"
        destructive
      />
    </Card>
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
      onLinked({ id: child.id, name: child.name, accountType: null, dateOfBirth: null, waiverAccepted: false, paymentStatus: null });
    } finally {
      setLinking(null);
    }
  }

  return (
    // Dialog (§4a.3): a short picker — centred, capped at max-w-lg, its own
    // scrolling body. The primitive supplies role="dialog", aria-modal,
    // Escape, focus trap and scroll lock; the search/link handlers are
    // unchanged.
    <Dialog
      open
      onClose={onClose}
      title="Link existing member as child"
      description="Only members without a password (kid sub-accounts) and not yet linked are eligible."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
        <div className="flex gap-2 mb-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && search()}
            placeholder="Search name or email"
            className="flex-1 px-3 py-2 rounded-lg text-sm outline-none border bg-sf-2"
            style={{ color: "var(--tx-1)", borderColor: "var(--bd-default)" }}
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
              <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg" style={{ background: "var(--sf-2)" }}>
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
    </Dialog>
  );
}

// ─── Create new kid sub-account ───────────────────────────────────────────────

function AddChildModal({
  parentId,
  parentName,
  onClose,
  onAdded,
}: {
  parentId: string;
  parentName: string;
  onClose: () => void;
  onAdded: (child: FamilyChildSummary) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
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
        paymentStatus: null,
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // Dialog (§4a.3): a two-field create form. The form element stays in the
    // body so `submit` keeps its FormEvent and Enter still submits; the footer
    // button reaches it by `form={formId}`.
    <Dialog
      open
      onClose={onClose}
      title={`Add child to ${parentName}`}
      description="The child cannot log in. Use the supervised waiver flow to collect a signature."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={submitting}
            disabled={!name.trim() || !dob}
          >
            Add child
          </Button>
        </>
      }
    >
        <form id={formId} onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--tx-4)" }}>Name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Child's full name"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none border bg-sf-2"
              style={{ color: "var(--tx-1)", borderColor: "var(--bd-default)" }}
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--tx-4)" }}>Date of birth *</label>
            <input
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              required
              className="w-full px-3 py-2 rounded-lg text-sm outline-none border bg-sf-2"
              style={{ color: "var(--tx-1)", borderColor: "var(--bd-default)" }}
            />
          </div>
        </form>
    </Dialog>
  );
}
