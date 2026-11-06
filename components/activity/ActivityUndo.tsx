"use client";

/**
 * Undo on the Activity page — owner only. The two routes it calls are the
 * existing ones and are not changed: `POST /api/audit-log/:id/undo` and
 * `POST /api/audit-log/undo-to`. The server decides what can be undone and
 * says why when it refuses; this file only asks, confirms and shows the answer.
 *
 * After an undo the list is not reloaded from the top: the row is struck
 * through where it is, so the person keeps their place and their filters.
 */
import { useCallback, useState, type ReactNode } from "react";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { auditLabelWithUndo } from "@/lib/audit-labels";
import { formatDateTime, formatTime } from "@/lib/date";
import type { FeedEntry } from "@/lib/activity-types";

type PlanItem = { id: string; action: string; createdAt: string; reason?: string };
type Plan = { reversible: PlanItem[]; skipped: PlanItem[] };
type UndoTo = { entry: FeedEntry; staff: { userId: string; name: string }; plan: Plan | null; planError: string | null };

const ALREADY_UNDONE = "Already undone.";
const LOST = "Lost the connection while undoing. Reloading so you can see what happened.";

export function useActivityUndo({
  entries,
  timeZone,
  toast,
  onUndone,
  onRefused,
  onUnsure,
}: {
  /** The rows on screen: an item in the "since here" list is described by its own sentence when it is one of these. */
  entries: FeedEntry[];
  timeZone: string;
  toast: (message: string, type?: "success" | "error" | "info" | "warning") => void;
  /** These rows were undone: strike them through in place. */
  onUndone: (ids: string[]) => void;
  /** The server refused to undo this row, for the reason given: the row says so instead of offering Undo again. */
  onRefused: (id: string, reason: string) => void;
  /** The outcome is not known (the connection dropped): reload page one. */
  onUnsure: () => void;
}): { askUndo: (entry: FeedEntry) => void; askUndoTo: (entry: FeedEntry) => void; dialogs: ReactNode } {
  const [one, setOne] = useState<FeedEntry | null>(null);
  const [many, setMany] = useState<UndoTo | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = useCallback(async (entry: FeedEntry, staff: { userId: string; name: string }) => {
    const asked: UndoTo = { entry, staff, plan: null, planError: null };
    setMany(asked);
    const answer = (next: Pick<UndoTo, "plan" | "planError">) => setMany((open) => (open === asked ? { ...asked, ...next } : open));
    try {
      const res = await fetch("/api/audit-log/undo-to", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: staff.userId, auditId: entry.id, preview: true }) });
      const data = (await res.json().catch(() => ({}))) as Partial<Plan> & { error?: string };
      if (!res.ok) answer({ plan: null, planError: data.error ?? "Couldn't work out what can be undone." });
      else answer({ plan: { reversible: data.reversible ?? [], skipped: data.skipped ?? [] }, planError: null });
    } catch {
      answer({ plan: null, planError: "Couldn't reach MatFlow. Nothing has changed." });
    }
  }, []);

  async function confirmOne() {
    if (!one) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/audit-log/${encodeURIComponent(one.id)}/undo`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        toast(data.error ?? "Couldn't undo that.", "error");
        // The server has decided this row cannot be undone now (someone already did, or it changed since): stop offering it.
        if (res.status === 409) {
          onRefused(one.id, data.error ?? "This can't be undone now.");
          setOne(null);
        }
        return;
      }
      toast(data.message ?? "Undone.", "success");
      onUndone([one.id]);
      setOne(null);
    } catch {
      toast(LOST, "error");
      setOne(null);
      onUnsure();
    } finally {
      setBusy(false);
    }
  }

  async function confirmMany() {
    if (!many?.plan) return;
    setBusy(true);
    try {
      const expectedIds = many.plan.reversible.map((p) => p.id);
      const res = await fetch("/api/audit-log/undo-to", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: many.staff.userId, auditId: many.entry.id, preview: false, expectedIds }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; undone?: string[] };
      if (!res.ok) {
        toast(data.error ?? "Nothing was undone.", "error");
        // They have done something since the preview: show the new list rather than a stale one.
        if (res.status === 409) await preview(many.entry, many.staff);
        return;
      }
      const undone = data.undone ?? expectedIds;
      toast(data.message ?? `Undone ${undone.length} ${undone.length === 1 ? "change" : "changes"}.`, "success");
      onUndone(undone);
      setMany(null);
    } catch {
      toast(LOST, "error");
      setMany(null);
      onUnsure();
    } finally {
      setBusy(false);
    }
  }

  const sentenceFor = (item: PlanItem) => entries.find((e) => e.id === item.id)?.plain ?? auditLabelWithUndo(item.action);

  const dialogs = (
    <>
      <ConfirmDialog
        open={!!one}
        onClose={() => {
          if (!busy) setOne(null);
        }}
        title={one ? `Undo: ${one.plain}?` : "Undo?"}
        description="This puts the recorded details back as they were before that action. Anything that action created or removed alongside (a booking, rank history, a Stripe change) stays as it is. The undo itself is recorded and can't be undone."
        confirmLabel="Undo this"
        loading={busy}
        onConfirm={confirmOne}
      />
      <ConfirmDialog
        open={!!many}
        onClose={() => {
          if (!busy) setMany(null);
        }}
        title={many ? `Undo everything ${many.staff.name} did since ${formatDateTime(many.entry.at, timeZone)}?` : "Undo?"}
        description={
          many?.planError
            ? many.planError
            : many?.plan
              ? `This covers everything ${many.staff.name} has done across the club since ${formatDateTime(many.entry.at, timeZone)}. ${many.plan.reversible.length} ${many.plan.reversible.length === 1 ? "change" : "changes"} will be put back, newest first, in one step; ${many.plan.skipped.length} can't be and will stay as ${many.plan.skipped.length === 1 ? "it is" : "they are"}. If any one of them has changed since, nothing is undone.`
              : "Working out what can be put back…"
        }
        confirmLabel={many?.plan ? `Undo ${many.plan.reversible.length} ${many.plan.reversible.length === 1 ? "change" : "changes"}` : "Undo"}
        loading={busy || (!!many && !many.plan && !many.planError)}
        confirmDisabled={!!many?.planError || !many?.plan || many.plan.reversible.length === 0}
        destructive
        onConfirm={confirmMany}
      >
        {many?.plan && many.plan.reversible.length + many.plan.skipped.length > 0 ? (
          <div className="mt-2 max-h-60 space-y-3 overflow-auto text-xs" data-testid="undo-plan">
            {many.plan.reversible.length > 0 ? (
              <div>
                <p className="font-medium text-tx-2">Will be put back</p>
                <ul className="mt-1 space-y-1 text-tx-2">
                  {many.plan.reversible.map((item) => (
                    <li key={item.id}>
                      <span className="tabular-nums text-tx-3">{formatTime(item.createdAt, timeZone)}</span> {sentenceFor(item)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {many.plan.skipped.length > 0 ? (
              <div>
                <p className="font-medium text-tx-2">Will stay as they are</p>
                <ul className="mt-1 space-y-1 text-tx-3">
                  {many.plan.skipped.map((item) => (
                    <li key={item.id}>
                      <span className="text-tx-2">{sentenceFor(item)}</span>
                      {item.reason ? ` — ${item.reason}` : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );

  return {
    askUndo: setOne,
    askUndoTo: (entry) => {
      if (entry.undo?.ok && entry.undo.sinceHere) void preview(entry, entry.undo.sinceHere);
    },
    dialogs,
  };
}

/** What a row looks like once it has been undone, before the next load says so itself. */
export function markUndone(entry: FeedEntry): FeedEntry {
  return { ...entry, undone: true, ...(entry.undo ? { undo: { ok: false as const, reason: ALREADY_UNDONE } } : {}) };
}
