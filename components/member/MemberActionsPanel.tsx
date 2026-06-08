"use client";

/**
 * MemberActionsPanel — embeddable card for the member's action list.
 *
 * Used in two places:
 *   - /member/home  → compact card with up to 3 items + "See all" link
 *   - /member/actions → full list (this same component with `full` mode)
 *
 * The visual answer to "make it clear what is a note and what is a built-in
 * to-do":
 *   - member_note (staff-authored): person icon + "from [staff name] · 2h ago"
 *   - system (computed): ⚡ icon + "Suggested by MatFlow"
 *
 * Ticking a member_note POSTs to /api/member/tasks/[id]/complete with
 * optimistic-remove + rollback on failure. System items are not tickable
 * here — they navigate to the resolution page (e.g. /member/profile to
 * sign the waiver) and disappear from the list once the condition is fixed.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, Sparkles, User as UserIcon } from "lucide-react";

type Item = {
  id: string;
  kind: "member_note" | "system";
  title: string;
  body: string | null;
  createdAt: string | null;
  createdBy: { id: string; name: string } | null;
  href: string | null;
};

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function MemberActionsPanel({ mode }: { mode: "compact" | "full" }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [completing, setCompleting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/member/tasks");
        if (!res.ok) {
          if (!cancelled) setItems([]);
          return;
        }
        const json = (await res.json()) as { items: Item[] };
        if (!cancelled) setItems(json.items ?? []);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function complete(it: Item) {
    if (it.kind !== "member_note") return;
    setCompleting(it.id);
    const prev = items;
    setItems((cur) => (cur ? cur.filter((x) => x.id !== it.id) : cur));
    try {
      const res = await fetch(`/api/member/tasks/${it.id}/complete`, { method: "POST" });
      if (!res.ok) setItems(prev);
    } catch {
      setItems(prev);
    } finally {
      setCompleting(null);
    }
  }

  if (items === null) {
    return (
      <div
        className="rounded-2xl border p-5 flex items-center gap-2 text-sm"
        style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "var(--member-text-muted)" }}
      >
        <Loader2 className="w-4 h-4 animate-spin" /> Loading your actions…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="rounded-2xl border p-6 flex flex-col items-center text-center gap-2"
        style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
      >
        <CheckCircle2 className="w-6 h-6" style={{ color: "#22c55e" }} />
        <p className="text-sm" style={{ color: "var(--member-text)" }}>
          Nothing to do — see you on the mats.
        </p>
      </div>
    );
  }

  const visible = mode === "compact" ? items.slice(0, 3) : items;
  const hiddenCount = items.length - visible.length;

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
    >
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: "var(--member-hr)" }}
      >
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--member-text)" }}>
            Your action list
          </p>
          <p className="text-xs" style={{ color: "var(--member-text-muted)" }}>
            {items.length} {items.length === 1 ? "thing" : "things"} to do
          </p>
        </div>
        {mode === "compact" && hiddenCount > 0 && (
          <Link
            href="/member/actions"
            className="text-xs font-semibold hover:opacity-80"
            style={{ color: "var(--member-text)" }}
          >
            See all
          </Link>
        )}
      </div>

      <ul>
        {visible.map((it) => (
          <li
            key={it.id}
            className="px-4 py-3 border-b last:border-b-0 flex items-start gap-3"
            style={{ borderColor: "var(--member-hr)" }}
          >
            {it.kind === "member_note" ? (
              <button
                type="button"
                onClick={() => complete(it)}
                disabled={completing === it.id}
                aria-label={`Mark "${it.title}" done`}
                className="mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center transition-colors disabled:opacity-40 hover:bg-white/5"
                style={{ borderColor: "var(--member-text-dim)" }}
              >
                {completing === it.id && <Loader2 className="w-3 h-3 animate-spin" />}
              </button>
            ) : it.href ? (
              <Link
                href={it.href}
                className="mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center transition-colors hover:bg-white/5"
                style={{ borderColor: "var(--member-text-dim)" }}
                aria-label={`Open ${it.title}`}
              >
                <Sparkles className="w-3 h-3" style={{ color: "#f59e0b" }} />
              </Link>
            ) : (
              <div
                className="mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center"
                style={{ borderColor: "var(--member-text-dim)" }}
              >
                <Sparkles className="w-3 h-3" style={{ color: "#f59e0b" }} />
              </div>
            )}

            <div className="flex-1 min-w-0">
              <p
                className="text-sm font-medium"
                style={{ color: "var(--member-text)" }}
              >
                {it.title}
              </p>
              {it.body && (
                <p
                  className="text-xs mt-0.5 whitespace-pre-wrap leading-relaxed"
                  style={{ color: "var(--member-text-muted)" }}
                >
                  {it.body}
                </p>
              )}
              <p
                className="text-[11px] mt-1.5 flex items-center gap-1"
                style={{ color: "var(--member-text-dim)" }}
              >
                {it.kind === "member_note" ? (
                  <>
                    <UserIcon className="w-3 h-3" />
                    <span>
                      {it.createdBy?.name ?? "Your gym"}
                      {it.createdAt && ` · ${relativeTime(it.createdAt)}`}
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-3 h-3" style={{ color: "#f59e0b" }} />
                    <span>Suggested by MatFlow</span>
                  </>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
