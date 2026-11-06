"use client";

/**
 * Mats: the club's training areas, managed from the Timetable page (owner and
 * manager). A mat is a column on a timetable split by mat; the order here is
 * the order of the columns.
 *
 * Three states: the club has typed places on its classes and no mats yet (one
 * press turns them into mats); no mats and nothing typed; or the list, where
 * a mat is renamed in place, moved, removed or added. Removing a mat never
 * removes a class. Every write is one request; a refused or failed one keeps
 * what was typed and says so beside it (UI-RULES §7).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Sheet } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/Toast";
import { MAT_LIMIT, MAT_NAME_MAX, cleanMatName, type PlaceSuggestion } from "@/lib/mats";

type Mat = { id: string; name: string; classCount: number };
type Loaded<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T };

const FIELD = "h-10 w-full min-w-0 rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 text-sm text-tx-1 placeholder:text-tx-3 hover:border-bd-hover";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const SAVE_FAILED = "Couldn't save that. Try again.";

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export function MatsSheet({
  open,
  onClose,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Something on the timetable may have changed (a mat, a class's mat, the
   * split). `quiet`: the sheet has already told the reader what the split is
   * now, so the page need not say it again.
   */
  onChanged: (opts?: { quiet?: boolean }) => void;
}) {
  const { toast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();
  const [mats, setMats] = useState<Loaded<Mat[]>>({ state: "loading" });
  const [places, setPlaces] = useState<Loaded<{ suggestions: PlaceSuggestion[]; noPlaceCount: number }>>({ state: "loading" });
  /** "Add a mat myself": show the list although the club has typed places and no mats. */
  const [listForced, setListForced] = useState(false);
  const [unticked, setUnticked] = useState<Set<string>>(() => new Set());
  const [adoptBusy, setAdoptBusy] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  /** The line under the heading after a successful adopt. */
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The new, not yet saved row: null = no such row. */
  const [newName, setNewName] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  /** One polite region for "Saved", moves, the adoption line and failures. */
  const [live, setLive] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const focusNext = useRef<string | null>(null);
  // A name being saved: Enter and then leaving the field must be one request, not two.
  const inFlight = useRef(new Set<string>());

  const load = useCallback(async (): Promise<Mat[] | null> => {
    const [m, p] = await Promise.all([
      fetch("/api/mats").then(async (r) => (r.ok ? ((await r.json()) as { mats: Mat[] }) : null)).catch(() => null),
      fetch("/api/mats/suggestions").then(async (r) => (r.ok ? ((await r.json()) as { suggestions: PlaceSuggestion[]; noPlaceCount: number }) : null)).catch(() => null),
    ]);
    setMats(m ? { state: "ready", value: m.mats } : { state: "error" });
    setPlaces(p ? { state: "ready", value: { suggestions: p.suggestions, noPlaceCount: p.noPlaceCount } } : { state: "error" });
    return m ? m.mats : null;
  }, []);

  // Opening starts from the club's own state every time: nothing typed last time is carried over.
  useEffect(() => {
    if (!open) return;
    setMats({ state: "loading" });
    setPlaces({ state: "loading" });
    setListForced(false);
    setUnticked(new Set());
    setAdoptError(null);
    setNotice(null);
    setDrafts({});
    setRowError({});
    setSavedId(null);
    setNewName(null);
    setNewError(null);
    setLive("");
    void load();
  }, [open, load]);

  // Focus follows a move, a removal or an add once the list has re-rendered.
  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    if (target === "#heading") heading.current?.focus();
    else if (target === "#add") addButton.current?.focus();
    else document.querySelector<HTMLElement>(`[data-mats-focus="${target}"]`)?.focus();
  });

  useEffect(() => {
    if (!savedId) return;
    const t = setTimeout(() => setSavedId(null), 2500);
    return () => clearTimeout(t);
  }, [savedId]);

  const list = mats.state === "ready" ? mats.value : [];
  const typed = places.state === "ready" ? places.value.suggestions : [];
  const firstRun = mats.state === "ready" && list.length === 0 && !listForced && (places.state !== "ready" || typed.some((s) => !s.matId));

  // ── First run: the places already typed ────────────────────────────────────
  // A place can become a mat when it is short enough and still within the twelve.
  let room = MAT_LIMIT - list.length;
  const offered = typed
    .filter((s) => !s.matId)
    .map((s) => {
      const reason = s.tooLong ? `Too long for a mat name (${MAT_NAME_MAX} characters at most)` : room <= 0 ? `You can have up to ${MAT_LIMIT} mats` : null;
      if (!reason) room -= 1;
      return { ...s, reason };
    });
  const chosen = offered.filter((s) => !s.reason && !unticked.has(s.key));

  async function adopt(keys: string[], after: (body: { matsAdded: number; classesAttached: number; layoutChanged: boolean; layout: { effective: "mat" | "time" } }) => string) {
    setAdoptBusy(true);
    setAdoptError(null);
    try {
      const res = await fetch("/api/mats/adopt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ keys }) });
      if (!res.ok) {
        // The server's own sentence when it gives one; after a refusal (404, 409) the list is read again first,
        // so the message sits beside what is really there. The boxes stay ticked for one more press.
        const message = await refused(res, "Couldn't add the mats. Try again.");
        setAdoptError(message);
        setLive(message);
        return;
      }
      const body = (await res.json()) as { matsAdded: number; classesAttached: number; layoutChanged: boolean; layout: { effective: "mat" | "time" } };
      const line = after(body);
      await load();
      setListForced(true);
      setNotice(line);
      setLive(line);
      focusNext.current = "#heading";
      // The line above has already said what the split is now, when it changed.
      onChanged({ quiet: body.layoutChanged });
    } catch {
      setAdoptError("Couldn't add the mats. Try again.");
      setLive("Couldn't add the mats. Try again.");
    } finally {
      setAdoptBusy(false);
    }
  }

  const adoptLine = (b: { matsAdded: number; classesAttached: number; layoutChanged: boolean; layout: { effective: "mat" | "time" } }) =>
    `${plural(b.matsAdded, "mat", "mats")} added. ${b.classesAttached === 1 ? "1 class is" : `${b.classesAttached} classes are`} now on a mat.` +
    (b.layoutChanged ? ` The timetable is now split by ${b.layout.effective === "mat" ? "mat" : "time"}.` : "");

  // ── The list ───────────────────────────────────────────────────────────────
  /** After a 404 or 409 the list is read again first, so the message sits beside what is really there. */
  async function refused(res: Response, fallback: string): Promise<string> {
    const message = (await readError(res)) ?? fallback;
    if (res.status === 404 || res.status === 409) await load();
    return message;
  }

  async function saveName(mat: Mat) {
    const draft = drafts[mat.id];
    if (draft === undefined) return;
    const name = cleanMatName(draft);
    const drop = () => setDrafts((d) => { const next = { ...d }; delete next[mat.id]; return next; });
    if (name === mat.name) { drop(); setRowError((e) => { const next = { ...e }; delete next[mat.id]; return next; }); return; }
    if (!name) { setRowError((e) => ({ ...e, [mat.id]: "Give the mat a name." })); setLive("Give the mat a name."); return; }
    if (inFlight.current.has(mat.id)) return;
    inFlight.current.add(mat.id);
    const failed = `Couldn't save ${mat.name}. Try again.`;
    try {
      const res = await fetch(`/api/mats/${mat.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) {
        const message = await refused(res, failed);
        setRowError((e) => ({ ...e, [mat.id]: message }));
        setLive(message);
        return;
      }
      setMats((m) => (m.state === "ready" ? { state: "ready", value: m.value.map((x) => (x.id === mat.id ? { ...x, name } : x)) } : m));
      drop();
      setRowError((e) => { const next = { ...e }; delete next[mat.id]; return next; });
      setSavedId(mat.id);
      setLive("Saved");
      onChanged();
    } catch {
      setRowError((e) => ({ ...e, [mat.id]: failed }));
      setLive(failed);
    } finally {
      inFlight.current.delete(mat.id);
    }
  }

  async function addMat() {
    if (newName === null) return;
    const name = cleanMatName(newName);
    if (!name) { setNewName(null); setNewError(null); return; }
    if (inFlight.current.has("#new")) return;
    inFlight.current.add("#new");
    const failed = `Couldn't save ${name}. Try again.`;
    try {
      const res = await fetch("/api/mats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) {
        const message = await refused(res, failed);
        setNewError(message);
        setLive(message);
        return;
      }
      const made = (await res.json()) as Mat;
      setMats((m) => ({ state: "ready", value: [...(m.state === "ready" ? m.value : []), { id: made.id, name: made.name, classCount: 0 }] }));
      setListForced(true);
      setNewName(null);
      setNewError(null);
      setSavedId(made.id);
      setLive(`${made.name} added`);
      focusNext.current = `name:${made.id}`;
      // The places typed with this name can now be put on it: read them again.
      void fetch("/api/mats/suggestions").then(async (r) => { if (r.ok) setPlaces({ state: "ready", value: await r.json() }); }).catch(() => {});
      onChanged();
    } catch {
      setNewError(failed);
      setLive(failed);
    } finally {
      inFlight.current.delete("#new");
    }
  }

  async function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (busy || to < 0 || to >= list.length) return;
    const before = list;
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    setMats({ state: "ready", value: next });
    focusNext.current = `${by === -1 ? "up" : "down"}:${before[index].id}`;
    setBusy(true);
    try {
      const res = await fetch("/api/mats/order", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: next.map((m) => m.id) }) });
      if (!res.ok) {
        // Left as it was; if the mats themselves have changed, show what is really there.
        if (res.status === 409) await load();
        else setMats({ state: "ready", value: before });
        toast(SAVE_FAILED, "error");
        return;
      }
      setLive(`${before[index].name} is now ${to + 1} of ${next.length}`);
      onChanged();
    } catch {
      setMats({ state: "ready", value: before });
      toast(SAVE_FAILED, "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(index: number) {
    const mat = list[index];
    const body = mat.classCount === 0 ? "No classes use it." : mat.classCount === 1 ? "Its 1 class stays on the timetable with no mat." : `Its ${mat.classCount} classes stay on the timetable with no mat.`;
    if (!(await ask({ title: `Remove ${mat.name}?`, body, confirmLabel: "Remove mat", cancelLabel: "Cancel", destructive: true }))) return;
    try {
      const res = await fetch(`/api/mats/${mat.id}`, { method: "DELETE" });
      if (!res.ok) {
        if (res.status === 404) await load();
        toast(SAVE_FAILED, "error");
        return;
      }
      const after = list.filter((m) => m.id !== mat.id);
      setMats({ state: "ready", value: after });
      focusNext.current = after[index] ? `name:${after[index].id}` : "#add";
      setLive(`${mat.name} removed`);
      void fetch("/api/mats/suggestions").then(async (r) => { if (r.ok) setPlaces({ state: "ready", value: await r.json() }); }).catch(() => {});
      onChanged();
    } catch {
      toast(SAVE_FAILED, "error");
    }
  }

  const strays = list.length > 0 ? typed.filter((s) => s.matId && list.some((m) => m.id === s.matId)) : [];
  const noneInUse = list.length > 0 && list.every((m) => m.classCount === 0);

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Mats">
        <div className="space-y-4" data-testid="mats-sheet">
          <p className="sr-only" role="status" aria-live="polite" data-testid="mats-live">{live}</p>

          {mats.state === "loading" ? <p className="text-sm text-tx-2">Loading your mats…</p> : null}

          {mats.state === "error" ? (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-tx-1">Couldn&rsquo;t load your mats.</p>
              <Button variant="secondary" onClick={() => { setMats({ state: "loading" }); void load(); }}>Try again</Button>
            </div>
          ) : null}

          {firstRun ? (
            <section className="space-y-3" aria-labelledby="mats-places-heading">
              <h3 id="mats-places-heading" ref={heading} tabIndex={-1} className="text-sm font-semibold text-tx-1">Places typed on your classes</h3>
              {places.state === "loading" ? <p className="text-sm text-tx-2">Loading…</p> : null}
              {places.state === "error" ? (
                <div className="space-y-2" role="alert">
                  <p className="text-sm text-tx-1">Couldn&rsquo;t load your typed places.</p>
                  <Button variant="secondary" onClick={() => { setPlaces({ state: "loading" }); void load(); }}>Try again</Button>
                </div>
              ) : null}
              {places.state === "ready" ? (
                <>
                  <ul className="space-y-1">
                    {offered.map((s) => {
                      const id = `mats-place-${s.key.replace(/[^a-z0-9]+/g, "-")}`;
                      return (
                        <li key={s.key} className="flex min-h-11 items-center gap-3">
                          <Checkbox
                            checked={!s.reason && !unticked.has(s.key)}
                            disabled={!!s.reason}
                            aria-labelledby={id}
                            aria-describedby={s.reason ? `${id}-why` : undefined}
                            onCheckedChange={(on) => setUnticked((u) => { const next = new Set(u); if (on) next.delete(s.key); else next.add(s.key); return next; })}
                          />
                          <span className="min-w-0">
                            <span id={id} className="block text-sm text-tx-1 [overflow-wrap:anywhere]">{s.name} · {plural(s.classCount, "class", "classes")}</span>
                            {s.reason ? <span id={`${id}-why`} className="block text-xs text-tx-2">{s.reason}</span> : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {places.value.noPlaceCount > 0 ? (
                    <p className="text-xs text-tx-2">
                      {places.value.noPlaceCount === 1 ? "1 class has no place. It will show under No mat." : `${places.value.noPlaceCount} classes have no place. They will show under No mat.`}
                    </p>
                  ) : null}
                </>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => adopt(chosen.map((s) => s.key), adoptLine)} disabled={chosen.length === 0 || adoptBusy} loading={adoptBusy}>Add these as mats</Button>
                <Button variant="secondary" onClick={() => { setListForced(true); setNewName(""); }}>Add a mat myself</Button>
              </div>
              {adoptError ? <p className="text-sm text-[var(--hue-danger-ink)]" role="alert">{adoptError}</p> : null}
            </section>
          ) : null}

          {mats.state === "ready" && !firstRun ? (
            <section className="space-y-3" aria-labelledby="mats-list-heading">
              <h3 id="mats-list-heading" ref={heading} tabIndex={-1} className="text-sm font-semibold text-tx-1">Your mats</h3>
              {notice ? <p className="text-sm text-tx-1" data-testid="mats-notice">{notice}</p> : null}
              {list.length === 0 && newName === null ? (
                <p className="text-sm text-tx-2">No mats yet. Add each training area, for example Mat 1 and Mat 2.</p>
              ) : null}
              {list.length > 0 ? <p className="text-xs text-tx-2">The order here is the order of the columns.</p> : null}
              <ul className="space-y-2">
                {list.map((mat, i) => {
                  const error = rowError[mat.id];
                  return (
                    <li key={mat.id} data-testid="mats-row">
                      <div className="flex items-center gap-1.5">
                        <input
                          aria-label={`${mat.name} name`}
                          aria-invalid={error ? true : undefined}
                          aria-describedby={error ? `mats-error-${mat.id}` : undefined}
                          data-mats-focus={`name:${mat.id}`}
                          className={FIELD}
                          maxLength={MAT_NAME_MAX}
                          value={drafts[mat.id] ?? mat.name}
                          onChange={(e) => setDrafts((d) => ({ ...d, [mat.id]: e.target.value }))}
                          onBlur={() => void saveName(mat)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); void saveName(mat); }
                            // Escape drops an unsaved change and stays in the sheet; with nothing to drop it closes the sheet.
                            if (e.key === "Escape" && drafts[mat.id] !== undefined && cleanMatName(drafts[mat.id]) !== mat.name) {
                              e.stopPropagation();
                              setDrafts((d) => { const next = { ...d }; delete next[mat.id]; return next; });
                              setRowError((r) => { const next = { ...r }; delete next[mat.id]; return next; });
                            }
                          }}
                        />
                        <Button variant="ghost" size="compact" className="px-2" aria-label={`Move ${mat.name} up`} aria-disabled={i === 0 || undefined} data-mats-focus={`up:${mat.id}`} onClick={() => void move(i, -1)}>
                          <ArrowUp aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="compact" className="px-2" aria-label={`Move ${mat.name} down`} aria-disabled={i === list.length - 1 || undefined} data-mats-focus={`down:${mat.id}`} onClick={() => void move(i, 1)}>
                          <ArrowDown aria-hidden="true" />
                        </Button>
                        <Button variant="ghost" size="compact" className="px-2" aria-label={`Remove ${mat.name}`} onClick={() => void remove(i)}>
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </div>
                      {error ? <p id={`mats-error-${mat.id}`} className="mt-1 text-xs text-[var(--hue-danger-ink)]" role="alert">{error}</p> : null}
                      {!error && savedId === mat.id ? <p className="mt-1 text-xs text-tx-2" data-testid="mats-saved">Saved</p> : null}
                    </li>
                  );
                })}
                {newName !== null ? (
                  <li data-testid="mats-new-row">
                    <input
                      autoFocus
                      aria-label="New mat name"
                      aria-invalid={newError ? true : undefined}
                      aria-describedby={newError ? "mats-error-new" : undefined}
                      className={FIELD}
                      maxLength={MAT_NAME_MAX}
                      placeholder="Mat 1"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onBlur={() => void addMat()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); void addMat(); }
                        if (e.key === "Escape") { e.stopPropagation(); setNewName(null); setNewError(null); focusNext.current = "#add"; }
                      }}
                    />
                    {newError ? <p id="mats-error-new" className="mt-1 text-xs text-[var(--hue-danger-ink)]" role="alert">{newError}</p> : null}
                  </li>
                ) : null}
              </ul>
              <Button ref={addButton} variant="secondary" onClick={() => { setNewName(""); setNewError(null); }} disabled={newName !== null}>
                <Plus aria-hidden="true" /> Add a mat
              </Button>
              {strays.map((s) => {
                const mat = list.find((m) => m.id === s.matId);
                if (!mat) return null;
                return (
                  <div key={s.key} className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3" data-testid="mats-stray">
                    <p className="min-w-0 flex-1 text-sm text-tx-1">
                      {s.classCount === 1 ? "1 class says" : `${s.classCount} classes say`} &ldquo;{mat.name}&rdquo; but {s.classCount === 1 ? "is" : "are"} not on it.
                    </p>
                    <Button
                      variant="secondary"
                      size="compact"
                      disabled={adoptBusy}
                      onClick={() => adopt([s.key], (b) => `${b.classesAttached === 1 ? "1 class is" : `${b.classesAttached} classes are`} now on ${mat.name}.` + (b.layoutChanged ? ` The timetable is now split by ${b.layout.effective === "mat" ? "mat" : "time"}.` : ""))}
                    >
                      Put them on {mat.name}
                    </Button>
                  </div>
                );
              })}
              {adoptError ? <p className="text-sm text-[var(--hue-danger-ink)]" role="alert">{adoptError}</p> : null}
              {noneInUse && strays.length === 0 ? <p className="text-xs text-tx-2">Put a class on a mat: open a class and choose its mat.</p> : null}
            </section>
          ) : null}
        </div>
      </Sheet>
      <ConfirmDialog {...dialogProps} />
    </>
  );
}

export default MatsSheet;
