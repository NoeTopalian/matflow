"use client";

import { useState, useMemo } from "react";
import { Plus, Trash2, Edit2, Award, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Sheet } from "@/components/ui/sheet";
import { hex } from "@/lib/color";
import type { RankRow } from "@/app/dashboard/ranks/page";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  initialRanks: RankRow[];
  primaryColor: string;
  role: string;
}

/**
 * What the form actually submits. Narrower than `RankRow` because the two
 * promotion-requirement fields live on a separate table and are read-only
 * here — the form must not pretend it can write them (UI-RULES §7).
 */
type RankInput = Pick<RankRow, "name" | "discipline" | "color" | "stripes" | "order">;

// ─── Preset belt systems ──────────────────────────────────────────────────────
//
// Belt colours are DOMAIN DATA (they are persisted in RankSystem.color and
// chosen by the gym), not chassis colour, so they stay literal hex here —
// UI-RULES §2 governs the chassis, not the content.

const PRESETS: Record<string, { name: string; color: string }[]> = {
  BJJ: [
    { name: "White", color: "#e5e7eb" },
    { name: "Blue", color: "#3b82f6" },
    { name: "Purple", color: "#8b5cf6" },
    { name: "Brown", color: "#92400e" },
    { name: "Black", color: "#111111" },
  ],
  Judo: [
    { name: "White (6th Kyu)", color: "#e5e7eb" },
    { name: "Yellow (5th Kyu)", color: "#fbbf24" },
    { name: "Orange (4th Kyu)", color: "#f97316" },
    { name: "Green (3rd Kyu)", color: "#22c55e" },
    { name: "Blue (2nd Kyu)", color: "#3b82f6" },
    { name: "Brown (1st Kyu)", color: "#92400e" },
    { name: "Black (1st Dan)", color: "#111111" },
  ],
  Karate: [
    { name: "White", color: "#e5e7eb" },
    { name: "Yellow", color: "#fbbf24" },
    { name: "Orange", color: "#f97316" },
    { name: "Green", color: "#22c55e" },
    { name: "Blue", color: "#3b82f6" },
    { name: "Purple", color: "#8b5cf6" },
    { name: "Red", color: "#ef4444" },
    { name: "Brown", color: "#92400e" },
    { name: "Black", color: "#111111" },
  ],
  Wrestling: [
    { name: "Novice", color: "#6b7280" },
    { name: "Intermediate", color: "#3b82f6" },
    { name: "Advanced", color: "#8b5cf6" },
    { name: "Elite", color: "#f59e0b" },
  ],
};

const RANK_COLORS = [
  "#e5e7eb", "#fbbf24", "#f97316", "#22c55e",
  "#3b82f6", "#8b5cf6", "#ef4444", "#92400e",
  "#111111", "#6b7280",
];

const DEFAULT_RANK_COLOR = "#6b7280";
const NEAR_WHITE_BELT = "#e5e7eb";
const BLACK_BELT = "#111111";

/**
 * A belt swatch needs a hairline whenever its own colour approaches either end
 * of the shell's range — a white belt on a white card and a black belt on a
 * dark preview both vanish without one (UI-RULES §2a worst-case accents).
 */
function swatchBorder(color: string): string | undefined {
  if (color === NEAR_WHITE_BELT) return "1px solid var(--bd-active)";
  if (color === BLACK_BELT) return "1px solid var(--bd-default)";
  return undefined;
}

// ─── Belt graphic ──────────────────────────────────────────────────────────────

function BeltGraphic({ color, stripes }: { color: string; stripes: number }) {
  const isDark = color === BLACK_BELT;
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <div
        className="flex h-4 w-10 items-center justify-end gap-0.5 rounded-sm pr-1"
        style={{ background: color, border: swatchBorder(color) }}
      >
        {Array.from({ length: Math.min(stripes, 4) }).map((_, i) => (
          <div
            key={i}
            className="h-3 w-2 rounded-sm"
            style={{ background: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)" }}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Add/Edit form ────────────────────────────────────────────────────────────

function RankForm({
  initial,
  disciplines,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<RankRow> | null;
  disciplines: string[];
  onSave: (data: RankInput) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [discipline, setDiscipline] = useState(initial?.discipline ?? disciplines[0] ?? "");
  const [newDiscipline, setNewDiscipline] = useState("");
  const [color, setColor] = useState(initial?.color ?? RANK_COLORS[0]);
  const [stripes, setStripes] = useState(initial?.stripes ?? 0);
  const [order, setOrder] = useState(initial?.order ?? 0);

  const effectiveDiscipline = discipline === "__new__" ? newDiscipline : discipline;

  const inputCls =
    "w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2.5 text-sm text-tx-1 outline-none transition-colors placeholder:text-tx-3 focus:border-bd-active";

  function submit() {
    if (!name.trim() || !effectiveDiscipline.trim()) return;
    onSave({ name: name.trim(), discipline: effectiveDiscipline.trim(), color, stripes, order });
  }

  return (
    <div className="space-y-4">
      <div>
        <label htmlFor="rank-discipline" className="mb-1.5 block text-xs font-medium text-tx-2">
          Discipline / art *
        </label>
        <select
          id="rank-discipline"
          className={`${inputCls} appearance-auto`}
          value={discipline}
          onChange={(e) => setDiscipline(e.target.value)}
        >
          {disciplines.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
          <option value="__new__">+ New discipline…</option>
        </select>
        {discipline === "__new__" && (
          <input
            className={`${inputCls} mt-2`}
            aria-label="New discipline name"
            placeholder="e.g. Wrestling"
            value={newDiscipline}
            onChange={(e) => setNewDiscipline(e.target.value)}
          />
        )}
      </div>

      <div>
        <label htmlFor="rank-name" className="mb-1.5 block text-xs font-medium text-tx-2">
          Rank name *
        </label>
        <input
          id="rank-name"
          className={inputCls}
          placeholder="e.g. Blue Belt"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rank-order" className="mb-1.5 block text-xs font-medium text-tx-2">
            Position (order)
          </label>
          <input
            id="rank-order"
            type="number"
            className={inputCls}
            value={order}
            onChange={(e) => setOrder(Number(e.target.value))}
            min={0}
          />
        </div>
        <div>
          <label htmlFor="rank-stripes" className="mb-1.5 block text-xs font-medium text-tx-2">
            Max stripes
          </label>
          <input
            id="rank-stripes"
            type="number"
            className={inputCls}
            value={stripes}
            onChange={(e) => setStripes(Number(e.target.value))}
            min={0}
            max={10}
          />
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-xs font-medium text-tx-2">Belt colour</span>
        <div className="flex flex-wrap gap-2">
          {RANK_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Belt colour ${c}`}
              aria-pressed={color === c}
              className="size-7 rounded-full transition-all"
              style={{
                background: c,
                border: swatchBorder(c),
                boxShadow: color === c ? `0 0 0 2px var(--sf-1), 0 0 0 4px ${c}` : "none",
              }}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label htmlFor="rank-custom-colour" className="text-xs text-tx-3">Custom</label>
          <input
            id="rank-custom-colour"
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="size-7 cursor-pointer rounded border-0 bg-transparent"
          />
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button variant="secondary" onClick={onCancel} className="flex-1">
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={!name.trim() || !effectiveDiscipline.trim()}
          loading={saving}
          className="flex-1"
        >
          {initial?.id ? "Save changes" : "Add rank"}
        </Button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RanksManager({ initialRanks, primaryColor, role }: Props) {
  const [ranks, setRanks] = useState<RankRow[]>(initialRanks);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RankRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RankRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const { toast: showToast } = useToast();

  const canManage = ["owner", "manager"].includes(role);

  // Group ranks by discipline
  const grouped = useMemo(() => {
    const map = new Map<string, RankRow[]>();
    for (const r of ranks) {
      if (!map.has(r.discipline)) map.set(r.discipline, []);
      map.get(r.discipline)!.push(r);
    }
    for (const v of map.values()) v.sort((a, b) => a.order - b.order);
    return map;
  }, [ranks]);

  const disciplines = Array.from(grouped.keys());
  const currentTab = activeTab ?? disciplines[0] ?? null;
  const visibleRanks = currentTab ? grouped.get(currentTab) ?? [] : [];

  function openAdd() {
    setEditTarget(null);
    setDrawerOpen(true);
  }

  // Escape, the scrim, the header X and the form's own Cancel all route
  // through these, so no dismissal path can abandon an in-flight save.
  function closeDrawer() {
    if (saving) return;
    setDrawerOpen(false);
  }

  function closePresets() {
    if (saving) return;
    setPresetOpen(false);
  }

  async function handleSave(data: RankInput) {
    setSaving(true);
    try {
      if (editTarget) {
        const res = await fetch(`/api/ranks/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error();
        const updated = await res.json();
        setRanks((prev) => prev.map((r) => (r.id === editTarget.id ? { ...r, ...updated } : r)));
        showToast("Rank updated", "success");
      } else {
        const res = await fetch("/api/ranks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed");
        }
        const created = await res.json();
        // A brand-new rank has no RankRequirement row yet — say so with null
        // rather than letting the cells read `undefined` (UI-RULES §7).
        setRanks((prev) => [...prev, { minAttendances: null, minMonths: null, ...created }]);
        setActiveTab(created.discipline);
        showToast("Rank added", "success");
      }
      setDrawerOpen(false);
    } catch (e: unknown) {
      showToast((e as Error).message || "Something went wrong", "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/ranks/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      setRanks((prev) => prev.filter((r) => r.id !== id));
      showToast("Rank deleted", "success");
    } catch (e: unknown) {
      showToast((e as Error).message || "Could not delete rank", "error");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  async function handleMove(id: string, direction: "up" | "down") {
    const rank = ranks.find((r) => r.id === id);
    if (!rank) return;
    const disc = grouped.get(rank.discipline) ?? [];
    const idx = disc.findIndex((r) => r.id === id);
    const target = direction === "up" ? disc[idx - 1] : disc[idx + 1];
    if (!target) return;

    // Swap orders
    const newOrder = target.order;
    const targetNewOrder = rank.order;

    try {
      await Promise.all([
        fetch(`/api/ranks/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: newOrder }),
        }),
        fetch(`/api/ranks/${target.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ order: targetNewOrder }),
        }),
      ]);
      setRanks((prev) =>
        prev.map((r) => {
          if (r.id === id) return { ...r, order: newOrder };
          if (r.id === target.id) return { ...r, order: targetNewOrder };
          return r;
        })
      );
    } catch {
      showToast("Failed to reorder", "error");
    }
  }

  async function applyPreset(presetName: string) {
    const preset = PRESETS[presetName];
    if (!preset) return;
    setSaving(true);
    try {
      const results: RankRow[] = [];
      for (let i = 0; i < preset.length; i++) {
        const res = await fetch("/api/ranks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            discipline: presetName,
            name: preset[i].name,
            order: i,
            color: preset[i].color,
            stripes: presetName === "BJJ" ? 4 : 0,
          }),
        });
        if (res.ok) results.push({ minAttendances: null, minMonths: null, ...(await res.json()) });
      }
      setRanks((prev) => [...prev, ...results]);
      setActiveTab(presetName);
      setPresetOpen(false);
      showToast(`${presetName} rank system added`, "success");
    } catch {
      showToast("Failed to apply preset", "error");
    } finally {
      setSaving(false);
    }
  }

  /**
   * Belt columns (UI-RULES §1.5.4 dense spec via the DataTable primitive).
   * Deliberately unsorted: `order` IS the semantics of a belt progression, and
   * the move up/down actions would be meaningless against a re-sorted table.
   */
  const columns: DataTableColumn<RankRow>[] = [
    {
      key: "belt",
      header: "Belt",
      cell: (rank) => (
        <div className="flex items-center gap-3">
          <BeltGraphic color={rank.color ?? DEFAULT_RANK_COLOR} stripes={rank.stripes} />
          <span className="truncate font-semibold text-tx-1">{rank.name}</span>
        </div>
      ),
    },
    {
      key: "order",
      header: "Order",
      width: "5rem",
      align: "right",
      cell: (rank) => <span className="text-tx-2">{rank.order + 1}</span>,
    },
    {
      key: "attendances",
      header: "Min attendances",
      width: "9rem",
      align: "right",
      cell: (rank) => (
        <span className="text-tx-2">{rank.minAttendances ?? "—"}</span>
      ),
    },
    {
      key: "months",
      header: "Min months",
      width: "7rem",
      align: "right",
      cell: (rank) => <span className="text-tx-2">{rank.minMonths ?? "—"}</span>,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      headerLabel: "Actions",
      width: "9rem",
      align: "right",
      cell: (rank) => {
        if (!canManage) return null;
        const idx = visibleRanks.findIndex((r) => r.id === rank.id);
        return (
          <div className="flex items-center justify-end gap-0.5">
            <Button
              variant="ghost"
              size="compact"
              onClick={() => handleMove(rank.id, "up")}
              disabled={idx <= 0}
              aria-label={`Move ${rank.name} up`}
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => handleMove(rank.id, "down")}
              disabled={idx === visibleRanks.length - 1}
              aria-label={`Move ${rank.name} down`}
            >
              <ChevronDown className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => { setEditTarget(rank); setDrawerOpen(true); }}
              aria-label={`Edit ${rank.name}`}
            >
              <Edit2 className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="compact"
              onClick={() => setDeleteTarget(rank)}
              aria-label={`Delete ${rank.name}`}
              style={{ color: "var(--hue-danger)" }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Rank systems"
        description={`${ranks.length} rank${ranks.length !== 1 ? "s" : ""} · Customise belt progressions`}
        action={
          canManage ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setPresetOpen(true)}>
                Use preset
              </Button>
              <Button onClick={openAdd}>
                <Plus className="size-4" />
                Add rank
              </Button>
            </div>
          ) : undefined
        }
      />

      {ranks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          {/* Belt progression preview — an illustration of what a rank system
              looks like, explicitly labelled as such. Not tenant data. */}
          <div className="mb-6">
            <p className="mb-3 text-[10px] font-semibold tracking-widest text-tx-3 uppercase">
              Belt progression preview
            </p>
            <div className="flex items-end justify-center gap-2">
              {[
                { color: "#e5e7eb", label: "White",  h: 28, stripes: 0 },
                { color: "#3b82f6", label: "Blue",   h: 36, stripes: 2 },
                { color: "#8b5cf6", label: "Purple", h: 44, stripes: 3 },
                { color: "#92400e", label: "Brown",  h: 52, stripes: 4 },
                { color: "#111111", label: "Black",  h: 64, stripes: 6 },
              ].map((belt) => (
                <div key={belt.label} className="flex flex-col items-center gap-2">
                  <div
                    className="relative w-12 overflow-hidden rounded-md"
                    style={{
                      height: belt.h,
                      background: belt.color,
                      border: swatchBorder(belt.color),
                    }}
                  >
                    {/* Stripe tip */}
                    <div
                      className="absolute top-0 right-0 bottom-0 flex w-3 flex-col items-center justify-center gap-px"
                      style={{ background: "rgba(0,0,0,0.12)" }}
                    >
                      {Array.from({ length: Math.min(belt.stripes, 4) }).map((_, i) => (
                        <div
                          key={i}
                          className="w-2 rounded-sm"
                          style={{
                            height: 3,
                            background: belt.color === BLACK_BELT ? "rgba(0,0,0,0.60)" : "rgba(0,0,0,0.4)",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <span className="text-[9px] font-medium text-tx-3">{belt.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div
            className="mb-3 flex size-12 items-center justify-center rounded-[var(--r-lg)]"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <Award className="size-6" style={{ color: primaryColor }} />
          </div>
          <h2 className="mb-1 text-lg font-bold text-tx-1">Build your rank system</h2>
          <p className="mb-6 max-w-xs text-sm leading-relaxed text-tx-3">
            Start with a BJJ, Judo, or Karate preset — or build a custom progression from scratch.
          </p>
          {canManage && (
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => setPresetOpen(true)}>
                Use preset
              </Button>
              <Button onClick={openAdd}>
                <Plus className="size-4" />
                Custom rank
              </Button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Discipline tabs — wrap rather than scroll, so the full set is
              visible at desktop widths (UI-RULES §4a.7). */}
          <div className="mb-4 flex flex-wrap gap-2 border-b border-bd-default pb-3">
            {disciplines.map((d) => {
              const active = currentTab === d;
              return (
                <Button
                  key={d}
                  variant={active ? "primary" : "secondary"}
                  size="compact"
                  onClick={() => setActiveTab(d)}
                  aria-current={active ? "true" : undefined}
                  className="rounded-full"
                >
                  {d}
                </Button>
              );
            })}
          </div>

          {/* ── Belts (DataTable — §1.5.4 dense spec; card-collapse below sm:) ──
              No `overflow-hidden`: it would become the table's nearest scroll
              container and make the sticky <thead> inert. */}
          <div className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1">
            <DataTable
              label={currentTab ? `${currentTab} ranks` : "Ranks"}
              rows={visibleRanks}
              rowKey={(r) => r.id}
              columns={columns}
              // renderCard contains interactive Buttons — do NOT add onRowClick to this table (nested-button a11y violation).
              renderCard={(rank) => {
                const idx = visibleRanks.findIndex((r) => r.id === rank.id);
                return (
                  <Card padding="tight" className="flex items-center gap-3">
                    <BeltGraphic color={rank.color ?? DEFAULT_RANK_COLOR} stripes={rank.stripes} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-tx-1">{rank.name}</p>
                      <p className="text-xs text-tx-3">
                        Order {rank.order + 1}
                        {rank.minAttendances != null && ` · ${rank.minAttendances} attendances`}
                        {rank.minMonths != null && ` · ${rank.minMonths} months`}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex shrink-0 items-center gap-0.5">
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => handleMove(rank.id, "up")}
                          disabled={idx <= 0}
                          aria-label={`Move ${rank.name} up`}
                        >
                          <ChevronUp className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => handleMove(rank.id, "down")}
                          disabled={idx === visibleRanks.length - 1}
                          aria-label={`Move ${rank.name} down`}
                        >
                          <ChevronDown className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => { setEditTarget(rank); setDrawerOpen(true); }}
                          aria-label={`Edit ${rank.name}`}
                        >
                          <Edit2 className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="compact"
                          onClick={() => setDeleteTarget(rank)}
                          aria-label={`Delete ${rank.name}`}
                          style={{ color: "var(--hue-danger)" }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </Card>
                );
              }}
            />
          </div>
        </>
      )}

      {/* Add/Edit — Sheet (UI-RULES §4a.3: multi-field form). */}
      <Sheet
        open={drawerOpen}
        onClose={closeDrawer}
        title={editTarget ? "Edit rank" : "Add rank"}
      >
        <RankForm
          initial={editTarget}
          disciplines={disciplines.length > 0 ? disciplines : ["BJJ"]}
          onSave={handleSave}
          onCancel={closeDrawer}
          saving={saving}
        />
      </Sheet>

      {/* Preset picker */}
      <Sheet
        open={presetOpen}
        onClose={closePresets}
        title="Choose a preset"
        description="Select a martial art to auto-populate the rank system."
      >
        <div className="space-y-3">
          {Object.entries(PRESETS).map(([name, belts]) => (
            <button
              key={name}
              type="button"
              onClick={() => applyPreset(name)}
              disabled={saving}
              className="w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4 text-left transition-colors hover:border-bd-hover hover:bg-sf-2 disabled:opacity-50"
            >
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-tx-1">{name}</p>
                <span className="text-xs text-tx-3">{belts.length} ranks</span>
              </div>
              <div className="flex gap-1.5">
                {belts.map((b) => (
                  <div
                    key={b.name}
                    className="h-3 w-6 rounded-sm"
                    style={{ background: b.color, border: swatchBorder(b.color) }}
                    title={b.name}
                  />
                ))}
              </div>
            </button>
          ))}
          {saving && (
            <p className="flex items-center gap-2 text-sm text-tx-3">
              <Loader2 className="size-4 animate-spin" />
              Adding ranks…
            </p>
          )}
        </div>
      </Sheet>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) return handleDelete(deleteTarget.id);
        }}
        title="Delete rank?"
        description={
          deleteTarget
            ? `Members holding ${deleteTarget.name} will lose it. This cannot be undone.`
            : undefined
        }
        confirmLabel="Delete rank"
        destructive
        loading={deleting}
      />
    </>
  );
}
