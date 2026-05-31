"use client";

// Three-strategy delete modal for the F5 parent-deletion gateway.
//
// First call to DELETE /api/members/[id] is the probe — no strategy, server
// returns 409 + kid list if the member has linked kids. The modal then
// renders the 3-strategy picker (reassign / cascade / orphan) and re-issues
// DELETE with ?strategy=…&toParentMemberId=… as appropriate.
//
// If the probe returns 200 immediately (member had no kids), the modal
// confirms the deletion and routes back to /dashboard/members.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, X, AlertTriangle, Users, Trash2, ArrowRight } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

type KidSummary = { id: string; name: string };
type Strategy = "reassign" | "cascade" | "orphan";

export function RemoveMemberModal({
  memberId,
  memberName,
  open,
  onClose,
  primaryColor,
}: {
  memberId: string;
  memberName: string;
  open: boolean;
  onClose: () => void;
  primaryColor: string;
}) {
  const router = useRouter();
  const { toast } = useToast();

  // Phase state machine. "confirm" = simple delete confirmation (no kids).
  // "picker" = 3-strategy choice (kids present). "running" = mid-DELETE.
  const [phase, setPhase] = useState<"loading" | "confirm" | "picker" | "running">("loading");
  const [kids, setKids] = useState<KidSummary[]>([]);
  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [reassignTo, setReassignTo] = useState<string | null>(null);
  const [reassignQuery, setReassignQuery] = useState("");
  const [reassignCandidates, setReassignCandidates] = useState<KidSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  // On open: probe via DELETE with no strategy. Picker fires only if 409
  // comes back with kids.
  useEffect(() => {
    if (!open) return;
    // Audit iter-1-dashboard A4H-5: these setState calls reset the state
    // machine when the modal opens (open flips false → true). React's
    // react-hooks/set-state-in-effect rule flags synchronous setState in
    // effects as a perf risk, but here it's intentional and bounded (runs
    // once per open transition, not per render). The alternative (key-based
    // remount) would discard mid-flight fetch results.
    /* eslint-disable react-hooks/set-state-in-effect */
    setPhase("loading");
    setKids([]);
    setStrategy(null);
    setReassignTo(null);
    setReassignQuery("");
    setReassignCandidates([]);
    setError(null);
    /* eslint-enable react-hooks/set-state-in-effect */

    (async () => {
      const res = await fetch(`/api/members/${memberId}`, { method: "DELETE" });
      if (res.status === 200) {
        // Member had no kids — gateway fast-path deleted them already. Close
        // + redirect.
        toast(`${memberName} removed`, "success");
        router.push("/dashboard/members");
        router.refresh();
        return;
      }
      if (res.status === 409) {
        const data = await res.json();
        if (Array.isArray(data?.kids) && data.kids.length > 0) {
          setKids(data.kids);
          setPhase("picker");
          return;
        }
        // Race or already removed.
        setError(data?.error ?? "Conflict — member may have been removed already");
        setPhase("confirm");
        return;
      }
      if (res.status === 404) {
        toast("Member not found", "error");
        onClose();
        return;
      }
      setError("Failed to start deletion. Try again.");
      setPhase("confirm");
    })();
  }, [open, memberId, memberName, onClose, router, toast]);

  // Reassign typeahead — debounced fetch of adult-shaped Members in the
  // tenant. Filter client-side to exclude the member being deleted and any
  // sub-account candidates (parentMemberId set).
  useEffect(() => {
    if (strategy !== "reassign") return;
    const q = reassignQuery.trim();
    if (q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clears stale results when user shortens query
      setReassignCandidates([]);
      return;
    }
    const handle = setTimeout(async () => {
      const res = await fetch(`/api/members?take=20`);
      if (!res.ok) return;
      const data = (await res.json()) as { members: Array<{ id: string; name: string; accountType: string; parentMemberId: string | null }> };
      const matches = data.members
        .filter((m) => m.id !== memberId)
        .filter((m) => m.parentMemberId === null) // not a sub-account
        .filter((m) => m.accountType !== "kids")  // not a kid
        .filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 10)
        .map((m) => ({ id: m.id, name: m.name }));
      setReassignCandidates(matches);
    }, 200);
    return () => clearTimeout(handle);
  }, [reassignQuery, strategy, memberId]);

  async function execute() {
    if (phase === "picker" && !strategy) {
      toast("Pick how to handle the linked kids", "error");
      return;
    }
    if (strategy === "reassign" && !reassignTo) {
      toast("Pick a new parent for the kids", "error");
      return;
    }
    setPhase("running");
    const params = new URLSearchParams();
    if (strategy) params.set("strategy", strategy);
    if (strategy === "reassign" && reassignTo) params.set("toParentMemberId", reassignTo);
    const url = `/api/members/${memberId}${params.toString() ? "?" + params.toString() : ""}`;
    const res = await fetch(url, { method: "DELETE" });
    if (res.ok) {
      const data = await res.json();
      toast(
        `${memberName} removed${data.kidsAffected > 0 ? ` (${data.kidsAffected} kid${data.kidsAffected === 1 ? "" : "s"} ${strategy === "cascade" ? "deleted" : strategy === "orphan" ? "orphaned" : "reassigned"})` : ""}`,
        "success",
      );
      router.push("/dashboard/members");
      router.refresh();
      return;
    }
    const data = await res.json().catch(() => ({}));
    setError(data?.error ?? "Deletion failed");
    setPhase("picker");
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-lg rounded-2xl border p-6" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
        <div className="flex items-start justify-between mb-4">
          <div>
            <h3 className="text-base font-semibold" style={{ color: "var(--tx-1)" }}>
              Remove {memberName}
            </h3>
            <p className="text-xs mt-1" style={{ color: "var(--tx-4)" }}>
              This permanently deletes the member and walks every dependent record. Cannot be undone.
            </p>
          </div>
          <button onClick={onClose} className="p-1 rounded" style={{ color: "var(--tx-3)" }} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {phase === "loading" && (
          <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--tx-3)" }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Checking for linked kids…
          </div>
        )}

        {phase === "confirm" && (
          <div className="space-y-3">
            {error ? (
              <p className="text-sm text-rose-400 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                {error}
              </p>
            ) : (
              <p className="text-sm" style={{ color: "var(--tx-2)" }}>
                {memberName} has no linked kids — safe to remove.
              </p>
            )}
          </div>
        )}

        {phase === "picker" && (
          <div className="space-y-4">
            <div className="rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs" style={{ background: "rgba(245,158,11,0.10)", color: "#fbbf24" }}>
              <Users className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold mb-0.5">{memberName} is a parent of {kids.length} {kids.length === 1 ? "kid" : "kids"}.</p>
                <p>Pick how to handle them before deletion. The choice is logged in the audit trail.</p>
              </div>
            </div>

            <div className="rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--bd-default)" }}>
              <p className="font-semibold mb-1" style={{ color: "var(--tx-2)" }}>Linked kids:</p>
              <ul className="space-y-0.5">
                {kids.map((k) => (
                  <li key={k.id} className="text-xs" style={{ color: "var(--tx-3)" }}>
                    · {k.name}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <StrategyOption
                value="reassign"
                selected={strategy === "reassign"}
                onSelect={() => setStrategy("reassign")}
                title="Reassign to another adult"
                body="Move every kid to another existing adult member. Their attendance and ranks stay intact under the new guardian."
                primaryColor={primaryColor}
              />
              <StrategyOption
                value="cascade"
                selected={strategy === "cascade"}
                onSelect={() => setStrategy("cascade")}
                title="Delete every kid too"
                body="Every linked kid runs through the same cascade walk and is removed permanently. Use when the whole family is leaving."
                primaryColor={primaryColor}
              />
              <StrategyOption
                value="orphan"
                selected={strategy === "orphan"}
                onSelect={() => setStrategy("orphan")}
                title="Orphan the kids (mark for re-guardian)"
                body="Each kid's account type flips to 'junior' and they're flagged for staff to re-link to a new guardian. Their data is preserved."
                primaryColor={primaryColor}
              />
            </div>

            {strategy === "reassign" && (
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--bd-default)" }}>
                <label className="block text-xs font-semibold mb-2" style={{ color: "var(--tx-2)" }}>
                  Pick the new parent
                </label>
                <input
                  type="text"
                  value={reassignQuery}
                  onChange={(e) => {
                    setReassignQuery(e.target.value);
                    setReassignTo(null);
                  }}
                  placeholder="Start typing a name…"
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                  style={{ background: "var(--sf-2)", color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
                />
                {reassignCandidates.length > 0 && !reassignTo && (
                  <ul className="mt-2 max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--bd-default)" }}>
                    {reassignCandidates.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setReassignTo(m.id);
                            setReassignQuery(m.name);
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-white/5"
                          style={{ color: "var(--tx-2)" }}
                        >
                          {m.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {reassignTo && (
                  <p className="text-xs mt-2" style={{ color: primaryColor }}>
                    ✓ Will reassign all {kids.length} kid{kids.length === 1 ? "" : "s"} to {reassignQuery}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-400 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {error}
              </p>
            )}
          </div>
        )}

        {phase === "running" && (
          <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--tx-3)" }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Removing…
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            disabled={phase === "running"}
            className="px-4 py-2 rounded-lg text-sm font-medium border disabled:opacity-50"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
          >
            Cancel
          </button>
          {phase === "confirm" && !error && (
            <button
              onClick={() => router.push("/dashboard/members")}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white inline-flex items-center gap-2"
              style={{ background: "#dc2626" }}
            >
              <Trash2 className="w-3.5 h-3.5" /> Already removed — back to list
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
          {phase === "picker" && (
            <button
              onClick={execute}
              disabled={!strategy || (strategy === "reassign" && !reassignTo)}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white inline-flex items-center gap-2 disabled:opacity-50"
              style={{ background: "#dc2626" }}
            >
              <Trash2 className="w-3.5 h-3.5" /> Remove + apply
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function StrategyOption({
  value,
  selected,
  onSelect,
  title,
  body,
  primaryColor,
}: {
  value: Strategy;
  selected: boolean;
  onSelect: () => void;
  title: string;
  body: string;
  primaryColor: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="w-full text-left rounded-lg border p-3 transition-colors"
      style={{
        borderColor: selected ? primaryColor : "var(--bd-default)",
        background: selected ? `${primaryColor}1A` : "var(--sf-1)",
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center"
          style={{ borderColor: selected ? primaryColor : "var(--bd-hover)" }}
          aria-hidden
          data-strategy={value}
        >
          {selected && <div className="w-2 h-2 rounded-full" style={{ background: primaryColor }} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
            {title}
          </p>
          <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
            {body}
          </p>
        </div>
      </div>
    </button>
  );
}
