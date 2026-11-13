"use client";

/**
 * Class categories: the club's own labels for its classes (Release B, 12 Nov 2026), managed from the Timetable page
 * by owners and managers, and only when category management is switched on for this deployment.
 *
 * A category is renamed in place, moved up or down, archived or restored, or added. A class has at most one category.
 * Archiving never removes a category from a class: the class keeps showing it, and it simply stops being offered for
 * a class. Every write carries the version of the category this sheet last read; if someone else changed it since,
 * the write is refused and the sheet reads the list again and says so (no edit overwrites a newer one). A refused or
 * failed write keeps what was typed and says so beside it (UI-RULES §7). Recorded in Activity, no Undo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Archive, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CATEGORY_NAME_MAX, cleanCategoryName } from "@/lib/class-category";

type Category = { id: string; name: string; legacyKey: string | null; archived: boolean; version: number; classCount: number };
type Loaded = { state: "loading" } | { state: "error" } | { state: "ready"; value: Category[] };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function readError(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

export function CategoriesSheet({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const [cats, setCatsState] = useState<Loaded>({ state: "loading" });
  // The list as it is now, updated in the same tick as every change, so a move that waited for a rename reads the
  // rename's result rather than the snapshot from when its button was pressed (round 2, B-R7).
  const catsRef = useRef<Loaded>({ state: "loading" });
  const setCats = useCallback((next: Loaded | ((c: Loaded) => Loaded)) => {
    const value = typeof next === "function" ? next(catsRef.current) : next;
    catsRef.current = value;
    setCatsState(value);
  }, []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const inFlight = useRef(new Set<string>());
  // Saves still on their way: a move waits for them (review B-N2).
  const pending = useRef(new Set<Promise<unknown>>());
  // A reorder still on its way (its PUT and the reload after it): a rename waits for it.
  const reorderInFlight = useRef<Promise<unknown> | null>(null);
  // Which version a write carries (B3-1). A write must carry the version the person SAW when they started it, plus
  // only the version bumps this sheet's own writes made since (counted from the server's answers). Never a version
  // read from a reload: a reload can carry another person's change the person never saw, and sending its version
  // would let the write overwrite that change silently. A stale base is refused by the server (409) and the sheet
  // then reloads and says so.
  const ownBumps = useRef(new Map<string, number>());
  const seen = useRef(new Map<string, { version: number; own: number }>());
  const shownVersion = (id: string) => (catsRef.current.state === "ready" ? catsRef.current.value.find((x) => x.id === id)?.version : undefined);
  const capture = (id: string, fallback: number) => ({ version: shownVersion(id) ?? fallback, own: ownBumps.current.get(id) ?? 0 });
  const versionFrom = (id: string, base: { version: number; own: number }) => base.version + ((ownBumps.current.get(id) ?? 0) - base.own);
  const countOwnBump = (id: string, by: number) => { if (by > 0) ownBumps.current.set(id, (ownBumps.current.get(id) ?? 0) + by); };
  // Edits begun before a reorder whose answer was lost, on rows it may have bumped: a refusal of one of them may be the
  // person's own unconfirmed move, or someone else's change, and the message says both (review F1). The mark ends with
  // the edit it was for.
  const unconfirmed = useRef(new Set<string>());
  const forget = (id: string) => { seen.current.delete(id); unconfirmed.current.delete(id); };
  // Bumped by every conflict: a move that waited for renames does not go ahead after one of them was refused (B3-7).
  const conflicts = useRef(0);
  const focusNext = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    // What this sheet had counted when the read went out: a version it counts while the read is on its way is newer
    // than the read, and the read must not take it back (review B3-1, N2).
    const countedBefore = new Map(ownBumps.current);
    try {
      const res = await fetch("/api/class-categories", { cache: "no-store" });
      if (!res.ok) { setCats({ state: "error" }); return; }
      const body = (await res.json()) as { categories: Category[] };
      const shownNow = catsRef.current.state === "ready" ? new Map(catsRef.current.value.map((c) => [c.id, c])) : new Map<string, Category>();
      // Where this sheet counted a write after the read went out and the screen is newer, keep the screen's row whole:
      // its name, archived state and version come from one server answer (review F2).
      const value = body.categories.map((c) => {
        const shownRow = shownNow.get(c.id);
        return (ownBumps.current.get(c.id) ?? 0) > (countedBefore.get(c.id) ?? 0) && shownRow && shownRow.version > c.version ? shownRow : c;
      });
      setCats({ state: "ready", value });
    } catch {
      setCats({ state: "error" });
    }
  }, [setCats]);

  useEffect(() => {
    if (!open) return;
    setCats({ state: "loading" });
    setDrafts({}); setRowError({}); setNotice(null); setNewName(null); setNewError(null);
    // The sheet stays mounted while closed: what was captured before it closed is not what is on screen now (S1).
    seen.current.clear();
    unconfirmed.current.clear();
    void load();
  }, [open, load, setCats]);

  // After a move or an add, keep keyboard focus on the control that was pressed (or the new row's name).
  useEffect(() => {
    if (!focusNext.current) return;
    const target = root.current?.querySelector<HTMLElement>(`[data-cat-focus="${focusNext.current}"]`);
    if (target) { target.focus(); focusNext.current = null; }
  });

  const list = cats.state === "ready" ? cats.value : [];
  const active = list.filter((c) => !c.archived);
  const archived = list.filter((c) => c.archived);

  /** A 409 means someone else changed the categories: read them again and say so, keeping nothing stale. */
  async function conflict(message: string) {
    conflicts.current++;
    await load();
    setDrafts({});
    seen.current.clear();
    unconfirmed.current.clear();
    // The notice is announced by its own role="alert"; the polite live region is for successes (review B-N3).
    setNotice(message);
  }

  async function patch(cat: Category, body: { name?: string; archived?: boolean }, failed: string, base: { version: number; own: number }): Promise<boolean> {
    if (inFlight.current.has(cat.id)) return false;
    inFlight.current.add(cat.id);
    const run = patchOnce(cat, body, failed, base);
    pending.current.add(run);
    try {
      return await run;
    } finally {
      pending.current.delete(run);
      inFlight.current.delete(cat.id);
    }
  }

  async function patchOnce(cat: Category, body: { name?: string; archived?: boolean }, failed: string, base: { version: number; own: number }): Promise<boolean> {
    if (reorderInFlight.current) await reorderInFlight.current.catch(() => {});
    // Read after the wait: a reorder this sheet made in the meantime has been counted by then.
    const sent = versionFrom(cat.id, base);
    try {
      const res = await fetch(`/api/class-categories/${cat.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: sent, ...body }),
      });
      if (res.status === 409) {
        const refusal = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        const message = refusal?.error ?? failed;
        // A name that clashes is the typist's to fix: keep the draft. A stale version (code "stale"): show what is
        // there now. The error paragraph beside the field is the announcement (role="alert"), not the live region too.
        if (body.name !== undefined && refusal?.code !== "stale") { setRowError((e) => ({ ...e, [cat.id]: message })); return false; }
        const ownMove = unconfirmed.current.has(cat.id);
        await conflict(ownMove ? "This change wasn't saved: your earlier move wasn't confirmed, or someone else changed this category. This is what's saved now; make it again if you still want it." : message);
        return false;
      }
      if (!res.ok) {
        const message = (await readError(res)) ?? failed;
        setRowError((e) => ({ ...e, [cat.id]: message }));
        return false;
      }
      const saved = (await res.json()) as { id: string; name: string; archived: boolean; version: number };
      countOwnBump(saved.id, saved.version - sent);
      setCats((c) => (c.state === "ready" ? { state: "ready", value: c.value.map((x) => (x.id === cat.id ? { ...x, name: saved.name, archived: saved.archived, version: saved.version } : x)) } : c));
      setRowError((e) => { const next = { ...e }; delete next[cat.id]; return next; });
      setNotice(null);
      onChanged();
      return true;
    } catch {
      setRowError((e) => ({ ...e, [cat.id]: failed }));
      return false;
    }
  }

  async function saveName(cat: Category) {
    const draft = drafts[cat.id];
    if (draft === undefined) return;
    const name = cleanCategoryName(draft);
    if (name === cat.name) { forget(cat.id); setDrafts((d) => { const next = { ...d }; delete next[cat.id]; return next; }); return; }
    if (!name) { setRowError((e) => ({ ...e, [cat.id]: "Give the category a name." })); return; }
    // The version the person saw when they started typing (captured at the first keystroke).
    const base = seen.current.get(cat.id) ?? capture(cat.id, cat.version);
    if (await patch(cat, { name }, `Couldn't rename ${cat.name}. Try again.`, base)) {
      forget(cat.id);
      setDrafts((d) => { const next = { ...d }; delete next[cat.id]; return next; });
      setLive(`Renamed to ${name}`);
    }
  }

  async function setArchived(cat: Category, archive: boolean) {
    // The version on screen when the button was pressed.
    const base = capture(cat.id, cat.version);
    const ok = await patch(cat, { archived: archive }, archive ? `Couldn't archive ${cat.name}. Try again.` : `Couldn't restore ${cat.name}. Try again.`, base);
    if (ok) {
      setLive(archive ? `${cat.name} archived; its classes keep it` : `${cat.name} restored`);
      focusNext.current = archive ? `restore:${cat.id}` : `archive:${cat.id}`;
    }
  }

  async function move(index: number, by: -1 | 1) {
    if (busy || index + by < 0 || index + by >= active.length) return;
    const movedId = active[index].id;
    // Busy from the press: a second press while renames finish cannot send a second reorder (round 2, B-R7).
    setBusy(true);
    const run = moveOnce(movedId, by);
    reorderInFlight.current = run;
    try {
      await run;
    } finally {
      reorderInFlight.current = null;
      setBusy(false);
    }
  }

  async function moveOnce(movedId: string, by: -1 | 1) {
    // Focus follows the moved row only if it was on the pressed button: a person who went on typing in a name while
    // this move waited keeps their place (review B3-2).
    const pressed = typeof document !== "undefined" ? document.activeElement : null;
    const conflictsBefore = conflicts.current;
    // Renames still on their way finish first, so the reorder carries the versions they produced (review B-N2).
    if (pending.current.size > 0) await Promise.allSettled([...pending.current]);
    // One of them was refused and the list reloaded: the person has not seen this move's starting point (B3-7).
    if (conflicts.current !== conflictsBefore) { setLive("Your move wasn't made."); return; }
    const now = catsRef.current.state === "ready" ? catsRef.current.value : [];
    const nowActive = now.filter((c) => !c.archived);
    const nowArchived = now.filter((c) => c.archived);
    const from = nowActive.findIndex((c) => c.id === movedId);
    const to = from + by;
    if (from < 0 || to < 0 || to >= nowActive.length) return;
    const order = [...nowActive];
    [order[from], order[to]] = [order[to], order[from]];
    // The order on screen, with the versions on screen: a reload that brought another person's change was shown.
    const items = [...order, ...nowArchived].map((c) => ({ id: c.id, version: c.version }));
    setCats({ state: "ready", value: [...order, ...nowArchived] });
    const focusHere = typeof document === "undefined" || document.activeElement === pressed || document.activeElement === document.body;
    if (focusHere) focusNext.current = `${by === -1 ? "up" : "down"}:${movedId}`;
    else {
      // The person is working elsewhere in the list: the swap may re-insert their row, so keep their place (N-a).
      const typingIn = (document.activeElement as HTMLElement | null)?.getAttribute?.("data-cat-focus");
      if (typingIn) focusNext.current = typingIn;
    }
    try {
      const res = await fetch("/api/class-categories/order", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
      if (res.status === 409) { await conflict((await readError(res)) ?? "Your categories have changed."); return; }
      if (!res.ok) {
        setCats({ state: "ready", value: now });
        const message = (await readError(res)) ?? "Couldn't move that. Try again.";
        setNotice(message);
        return;
      }
      // The rows this reorder moved went up by one version each: counted as this sheet's own, then the list is read
      // again (it may also bring another person's change, which an edit started earlier will then be refused over).
      const done = (await res.json().catch(() => null)) as { moved?: { id: string; version: number }[] } | null;
      const sentVersion = new Map(items.map((i) => [i.id, i.version]));
      const movedTo = new Map((done?.moved ?? []).map((m) => [m.id, m.version]));
      // Counted and shown in the same step: an edit begun before the reload below lands must not pair the old
      // version on screen with a bump already counted (that sends one version short and is refused as stale).
      for (const [id, version] of movedTo) countOwnBump(id, version - (sentVersion.get(id) ?? version));
      setCats((c) => (c.state === "ready" ? { state: "ready", value: c.value.map((x) => (movedTo.has(x.id) ? { ...x, version: movedTo.get(x.id)! } : x)) } : c));
      await load();
      setLive(`${order[to].name} is now ${to + 1} of ${order.length}`);
      onChanged();
    } catch {
      // No answer (a dropped connection): the move may or may not have been saved. Show what is saved rather than
      // guess; the person can press again. Its version bumps are not counted as this sheet's, so an edit started
      // before it on a row it moved is refused (409) rather than applied over a version it cannot account for, and
      // that refusal says it was the unconfirmed move (N3).
      // Only edits that were already under way: anything begun after the reload below captures the saved versions.
      for (const i of items) if (seen.current.has(i.id) || inFlight.current.has(i.id)) unconfirmed.current.add(i.id);
      await load();
      setNotice("Couldn't confirm that move. This is the order as saved; move it again if it isn't right.");
    }
  }

  async function add() {
    if (newName === null) return;
    const name = cleanCategoryName(newName);
    if (!name) { setNewName(null); setNewError(null); return; }
    if (inFlight.current.has("#new")) return;
    inFlight.current.add("#new");
    const failed = `Couldn't add ${name}. Try again.`;
    try {
      const res = await fetch("/api/class-categories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      if (!res.ok) {
        const message = (await readError(res)) ?? failed;
        setNewError(message);
        return;
      }
      const made = (await res.json()) as Category;
      setCats((c) => (c.state === "ready" ? { state: "ready", value: [...c.value.filter((x) => !x.archived), made, ...c.value.filter((x) => x.archived)] } : c));
      setNewName(null);
      setNewError(null);
      setLive(`${made.name} added`);
      focusNext.current = `name:${made.id}`;
      onChanged();
    } catch {
      setNewError(failed);
    } finally {
      inFlight.current.delete("#new");
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Class categories">
      <div ref={root} className="space-y-4" data-testid="categories-sheet">
        <p className="sr-only" role="status" aria-live="polite" data-testid="categories-live">{live}</p>
        {cats.state === "loading" ? <p className="text-sm text-tx-2">Loading your categories…</p> : null}
        {cats.state === "error" ? (
          <div className="space-y-2" role="alert">
            <p className="text-sm text-tx-1">Couldn&apos;t load your categories.</p>
            <Button variant="secondary" size="compact" onClick={() => { setCats({ state: "loading" }); void load(); }}>Try again</Button>
          </div>
        ) : null}
        {cats.state === "ready" ? (
          <>
            <p className="text-xs text-tx-2">A class has one category. It shows on the timetable, the members&apos; schedule and the kiosk, and doesn&apos;t change who can attend. The order here is the order the class form offers them.</p>
            {notice ? <p className="text-sm text-tx-1" role="alert" data-testid="categories-notice">{notice}</p> : null}
            <ul className="space-y-2" aria-label="Categories in use">
              {active.map((cat, i) => {
                const error = rowError[cat.id];
                return (
                  <li key={cat.id} data-testid="categories-row">
                    <div className="flex items-center gap-1.5">
                      <Input
                        aria-label={`${cat.name} name`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? `categories-error-${cat.id}` : `categories-count-${cat.id}`}
                        data-cat-focus={`name:${cat.id}`}
                        className="min-w-0"
                        maxLength={CATEGORY_NAME_MAX}
                        value={drafts[cat.id] ?? cat.name}
                        onChange={(e) => {
                          if (!seen.current.has(cat.id)) seen.current.set(cat.id, capture(cat.id, cat.version));
                          const value = e.target.value;
                          setDrafts((d) => ({ ...d, [cat.id]: value }));
                        }}
                        onBlur={() => void saveName(cat)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveName(cat); }
                          if (e.key === "Escape" && drafts[cat.id] !== undefined && cleanCategoryName(drafts[cat.id]) !== cat.name) {
                            e.stopPropagation();
                            // A cancelled rename's starting version is not the next rename's (S1).
                            forget(cat.id);
                            setDrafts((d) => { const next = { ...d }; delete next[cat.id]; return next; });
                            setRowError((r) => { const next = { ...r }; delete next[cat.id]; return next; });
                          }
                        }}
                      />
                      <Button variant="ghost" size="compact" className="px-2" aria-label={`Move ${cat.name} up`} aria-disabled={i === 0 || undefined} data-cat-focus={`up:${cat.id}`} onClick={() => void move(i, -1)}>
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="compact" className="px-2" aria-label={`Move ${cat.name} down`} aria-disabled={i === active.length - 1 || undefined} data-cat-focus={`down:${cat.id}`} onClick={() => void move(i, 1)}>
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      <Button variant="ghost" size="compact" className="px-2" aria-label={`Archive ${cat.name}`} data-cat-focus={`archive:${cat.id}`} onClick={() => void setArchived(cat, true)}>
                        <Archive aria-hidden="true" />
                      </Button>
                    </div>
                    <p id={`categories-count-${cat.id}`} className="mt-1 text-xs text-tx-2">{cat.classCount ? plural(cat.classCount, "class", "classes") : "No classes yet"}</p>
                    {error ? <p id={`categories-error-${cat.id}`} className="mt-1 text-xs text-[var(--hue-danger-ink)]" role="alert">{error}</p> : null}
                  </li>
                );
              })}
              {newName !== null ? (
                <li data-testid="categories-new-row">
                  <Input
                    autoFocus
                    aria-label="New category name"
                    aria-invalid={newError ? true : undefined}
                    aria-describedby={newError ? "categories-error-new" : undefined}
                    className="min-w-0"
                    maxLength={CATEGORY_NAME_MAX}
                    placeholder="Intermediate"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onBlur={() => void add()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); void add(); }
                      if (e.key === "Escape") { e.stopPropagation(); setNewName(null); setNewError(null); }
                    }}
                  />
                  {newError ? <p id="categories-error-new" className="mt-1 text-xs text-[var(--hue-danger-ink)]" role="alert">{newError}</p> : null}
                </li>
              ) : null}
            </ul>
            <Button variant="secondary" onClick={() => { setNewName(""); setNewError(null); }} disabled={newName !== null}>
              <Plus aria-hidden="true" /> Add a category
            </Button>
            {archived.length > 0 ? (
              <section className="space-y-2" aria-labelledby="categories-archived-heading">
                <h3 id="categories-archived-heading" className="text-sm font-semibold text-tx-1">Archived</h3>
                <p className="text-xs text-tx-2">Classes keep an archived category, but it isn&apos;t offered for a class until you restore it.</p>
                <ul className="space-y-2">
                  {archived.map((cat) => {
                    const error = rowError[cat.id];
                    return (
                      <li key={cat.id} className="flex items-center justify-between gap-2" data-testid="categories-archived-row">
                        <span className="text-sm text-tx-1">{cat.name} <span className="text-xs text-tx-2">· {cat.classCount ? `kept by ${plural(cat.classCount, "class", "classes")}` : "no classes"}</span></span>
                        <Button variant="secondary" size="compact" aria-label={`Restore ${cat.name}`} aria-describedby={error ? `categories-error-${cat.id}` : undefined} data-cat-focus={`restore:${cat.id}`} onClick={() => void setArchived(cat, false)}>
                          <RotateCcw aria-hidden="true" /> Restore
                        </Button>
                        {error ? <p id={`categories-error-${cat.id}`} className="text-xs text-[var(--hue-danger-ink)]" role="alert">{error}</p> : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
