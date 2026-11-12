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
  const [cats, setCats] = useState<Loaded>({ state: "loading" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const inFlight = useRef(new Set<string>());
  // Saves still on their way, and the version each one came back with: a move waits for them and sends the newest
  // versions, so a rename followed at once by a move is not refused as somebody else's change (review B-N2).
  const pending = useRef(new Set<Promise<unknown>>());
  const latestVersion = useRef(new Map<string, number>());
  const focusNext = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/class-categories", { cache: "no-store" });
      if (!res.ok) { setCats({ state: "error" }); return; }
      const body = (await res.json()) as { categories: Category[] };
      latestVersion.current.clear();
      setCats({ state: "ready", value: body.categories });
    } catch {
      setCats({ state: "error" });
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setCats({ state: "loading" });
    setDrafts({}); setRowError({}); setNotice(null); setNewName(null); setNewError(null);
    void load();
  }, [open, load]);

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
    await load();
    setDrafts({});
    // The notice is announced by its own role="alert"; the polite live region is for successes (review B-N3).
    setNotice(message);
  }

  async function patch(cat: Category, body: { name?: string; archived?: boolean }, failed: string): Promise<boolean> {
    if (inFlight.current.has(cat.id)) return false;
    inFlight.current.add(cat.id);
    const run = patchOnce(cat, body, failed);
    pending.current.add(run);
    try {
      return await run;
    } finally {
      pending.current.delete(run);
      inFlight.current.delete(cat.id);
    }
  }

  async function patchOnce(cat: Category, body: { name?: string; archived?: boolean }, failed: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/class-categories/${cat.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: latestVersion.current.get(cat.id) ?? cat.version, ...body }),
      });
      if (res.status === 409) {
        const refusal = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
        const message = refusal?.error ?? failed;
        // A name that clashes is the typist's to fix: keep the draft. A stale version (code "stale"): show what is
        // there now. The error paragraph beside the field is the announcement (role="alert"), not the live region too.
        if (body.name !== undefined && refusal?.code !== "stale") { setRowError((e) => ({ ...e, [cat.id]: message })); return false; }
        await conflict(message);
        return false;
      }
      if (!res.ok) {
        const message = (await readError(res)) ?? failed;
        setRowError((e) => ({ ...e, [cat.id]: message }));
        return false;
      }
      const saved = (await res.json()) as { id: string; name: string; archived: boolean; version: number };
      latestVersion.current.set(saved.id, saved.version);
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
    if (name === cat.name) { setDrafts((d) => { const next = { ...d }; delete next[cat.id]; return next; }); return; }
    if (!name) { setRowError((e) => ({ ...e, [cat.id]: "Give the category a name." })); return; }
    if (await patch(cat, { name }, `Couldn't rename ${cat.name}. Try again.`)) {
      setDrafts((d) => { const next = { ...d }; delete next[cat.id]; return next; });
      setLive(`Renamed to ${name}`);
    }
  }

  async function setArchived(cat: Category, archive: boolean) {
    const ok = await patch(cat, { archived: archive }, archive ? `Couldn't archive ${cat.name}. Try again.` : `Couldn't restore ${cat.name}. Try again.`);
    if (ok) {
      setLive(archive ? `${cat.name} archived; its classes keep it` : `${cat.name} restored`);
      focusNext.current = archive ? `restore:${cat.id}` : `archive:${cat.id}`;
    }
  }

  async function move(index: number, by: -1 | 1) {
    const to = index + by;
    if (busy || to < 0 || to >= active.length) return;
    if (pending.current.size > 0) await Promise.allSettled([...pending.current]);
    const order = [...active];
    [order[index], order[to]] = [order[to], order[index]];
    const items = [...order, ...archived].map((c) => ({ id: c.id, version: latestVersion.current.get(c.id) ?? c.version }));
    const before = list;
    setCats({ state: "ready", value: [...order, ...archived] });
    focusNext.current = `${by === -1 ? "up" : "down"}:${active[index].id}`;
    setBusy(true);
    try {
      const res = await fetch("/api/class-categories/order", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
      if (res.status === 409) { await conflict((await readError(res)) ?? "Your categories have changed."); return; }
      if (!res.ok) {
        setCats({ state: "ready", value: before });
        const message = (await readError(res)) ?? "Couldn't move that. Try again.";
        setNotice(message);
        return;
      }
      // A moved row's version went up by one: read the list again so the next write carries the new versions.
      await load();
      setLive(`${active[index].name} is now ${to + 1} of ${active.length}`);
      onChanged();
    } catch {
      setCats({ state: "ready", value: before });
      setNotice("Couldn't move that. Try again.");
    } finally {
      setBusy(false);
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
      setLive(failed);
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
                        onChange={(e) => setDrafts((d) => ({ ...d, [cat.id]: e.target.value }))}
                        onBlur={() => void saveName(cat)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveName(cat); }
                          if (e.key === "Escape" && drafts[cat.id] !== undefined && cleanCategoryName(drafts[cat.id]) !== cat.name) {
                            e.stopPropagation();
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
