"use client";

import { useState, useMemo } from "react";
import { Plus, Trash2, Edit2, Award, X, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { RankRow } from "@/app/dashboard/ranks/page";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  initialRanks: RankRow[];
  primaryColor: string;
  role: string;
}

// ─── Preset belt systems ──────────────────────────────────────────────────────

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

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Belt graphic ──────────────────────────────────────────────────────────────

function BeltGraphic({ color, stripes }: { color: string; stripes: number }) {
  const isDark = color === "#111111";
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <div
        className="w-10 h-4 rounded-sm flex items-center justify-end pr-1 gap-0.5"
        style={{ background: color, border: isDark ? "1px solid rgba(0,0,0,0.12)" : undefined }}
      >
        {Array.from({ length: Math.min(stripes, 4) }).map((_, i) => (
          <div key={i} className="w-2 h-3 rounded-sm" style={{ background: isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.35)" }} />
        ))}
      </div>
    </div>
  );
}

// ─── Rank card ────────────────────────────────────────────────────────────────

function RankCard({
  rank,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
  isFirst,
  isLast,
  canManage,
}: {
  rank: RankRow;
  onEdit: (r: RankRow) => void;
  onDelete: (id: string) => void;
  onMoveUp: (id: string) => void;
  onMoveDown: (id: string) => void;
  isFirst: boolean;
  isLast: boolean;
  canManage: boolean;
}) {
  const color = rank.color ?? "#6b7280";
  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-2xl border"
      style={{ background: hex(color, 0.04), borderColor: hex(color, 0.2) }}
    >
      <BeltGraphic color={color} stripes={rank.stripes} />
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-semibold">{rank.name}</p>
        <p className="text-gray-600 text-xs">Order {rank.order + 1}</p>
      </div>
      {canManage && (
        <div className="flex items-center gap-1">
          <button
            onClick={() => onMoveUp(rank.id)}
            disabled={isFirst}
            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-white disabled:opacity-20 transition-colors"
          >
            <ChevronUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onMoveDown(rank.id)}
            disabled={isLast}
            className="w-6 h-6 rounded flex items-center justify-center text-gray-600 hover:text-white disabled:opacity-20 transition-colors"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onEdit(rank)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-colors"
          >
            <Edit2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(rank.id)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Add/Edit form ────────────────────────────────────────────────────────────

function RankForm({
  initial,
  disciplines,
  primaryColor,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<RankRow> | null;
  disciplines: string[];
  primaryColor: string;
  onSave: (data: Omit<RankRow, "id">) => void;
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

  const inputCls = "w-full bg-transparent border border-black/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/30 transition-colors";

  function submit() {
    if (!name.trim() || !effectiveDiscipline.trim()) return;
    onSave({ name: name.trim(), discipline: effectiveDiscipline.trim(), color, stripes, order });
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Discipline / Art *</label>
        <select
          className={inputCls}
          value={discipline}
          onChange={(e) => setDiscipline(e.target.value)}
          style={{ appearance: "auto" }}
        >
          {disciplines.map((d) => (
            <option key={d} value={d} style={{ background: "var(--sf-1)" }}>{d}</option>
          ))}
          <option value="__new__" style={{ background: "var(--sf-1)" }}>+ New discipline…</option>
        </select>
        {discipline === "__new__" && (
          <input
            className={inputCls + " mt-2"}
            placeholder="e.g. Wrestling"
            value={newDiscipline}
            onChange={(e) => setNewDiscipline(e.target.value)}
          />
        )}
      </div>

      <div>
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Rank Name *</label>
        <input
          className={inputCls}
          placeholder="e.g. Blue Belt"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Position (order)</label>
          <input
            type="number"
            className={inputCls}
            value={order}
            onChange={(e) => setOrder(Number(e.target.value))}
            min={0}
          />
        </div>
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Max Stripes</label>
          <input
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
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Belt Colour</label>
        <div className="flex gap-2 flex-wrap">
          {RANK_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="w-7 h-7 rounded-full transition-all"
              style={{
                background: c,
                border: c === "#e5e7eb" ? "1px solid rgba(255,255,255,0.2)" : c === "#111111" ? "1px solid rgba(0,0,0,0.12)" : "none",
                boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : "none",
              }}
            />
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <label className="text-gray-600 text-xs">Custom</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-7 h-7 rounded cursor-pointer border-0"
            style={{ background: "transparent" }}
          />
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl border border-black/10 text-gray-400 text-sm font-medium hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!name.trim() || !effectiveDiscipline.trim() || saving}
          className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: primaryColor }}
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" />}
          {initial?.id ? "Save Changes" : "Add Rank"}
        </button>
      </div>
    </div>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div
        className="fixed top-0 right-0 h-full w-full max-w-md z-50 flex flex-col overflow-hidden"
        style={{ background: "var(--sf-0)", borderLeft: "1px solid rgba(255,255,255,0.08)" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/8">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400" style={{ background: "rgba(255,255,255,0.08)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function RanksManager({ initialRanks, primaryColor, role }: Props) {
  const [ranks, setRanks] = useState<RankRow[]>(initialRanks);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<RankRow | null>(null);
  const [saving, setSaving] = useState(false);
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

  function openAdd() {
    setEditTarget(null);
    setDrawerOpen(true);
  }

  async function handleSave(data: Omit<RankRow, "id">) {
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
        setRanks((prev) => [...prev, created]);
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
    if (!confirm("Delete this rank? Members with this rank will lose it.")) return;
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
        if (res.ok) results.push(await res.json());
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

  return (
    <div className="max-w-3xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Rank Systems</h1>
          <p className="text-gray-500 text-sm mt-0.5">{ranks.length} rank{ranks.length !== 1 ? "s" : ""} · Customise belt progressions</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              onClick={() => setPresetOpen(true)}
              className="px-4 py-2 rounded-xl border border-black/10 text-gray-300 text-sm font-medium hover:text-white transition-colors"
            >
              Use Preset
            </button>
            <button
              onClick={openAdd}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold"
              style={{ background: primaryColor }}
            >
              <Plus className="w-4 h-4" />
              Add Rank
            </button>
          </div>
        )}
      </div>

      {ranks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          {/* Visual belt progression preview */}
          <div className="mb-6">
            <p className="text-gray-600 text-[10px] uppercase tracking-widest font-semibold mb-3">Belt Progression Preview</p>
            <div className="flex items-end gap-2 justify-center">
              {[
                { color: "#e5e7eb", label: "White",  h: 28, stripes: 0 },
                { color: "#3b82f6", label: "Blue",   h: 36, stripes: 2 },
                { color: "#8b5cf6", label: "Purple", h: 44, stripes: 3 },
                { color: "#92400e", label: "Brown",  h: 52, stripes: 4 },
                { color: "#111111", label: "Black",  h: 64, stripes: 6 },
              ].map((belt) => (
                <div key={belt.label} className="flex flex-col items-center gap-2">
                  <div
                    className="w-12 rounded-md relative overflow-hidden"
                    style={{
                      height: belt.h,
                      background: belt.color,
                      border: belt.color === "#e5e7eb" ? "1px solid rgba(255,255,255,0.2)"
                            : belt.color === "#111111" ? "1px solid rgba(0,0,0,0.12)"
                            : "none",
                    }}
                  >
                    {/* Stripe tip */}
                    <div
                      className="absolute right-0 top-0 bottom-0 w-3 flex flex-col justify-center items-center gap-px"
                      style={{ background: belt.color === "#111111" ? "rgba(0,0,0,0.10)" : "rgba(0,0,0,0.12)" }}
                    >
                      {Array.from({ length: Math.min(belt.stripes, 4) }).map((_, i) => (
                        <div
                          key={i}
                          className="w-2 rounded-sm"
                          style={{
                            height: 3,
                            background: belt.color === "#111111" ? "rgba(0,0,0,0.60)" : "rgba(0,0,0,0.4)",
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <span className="text-gray-600 text-[9px] font-medium">{belt.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <Award className="w-6 h-6" style={{ color: primaryColor }} />
          </div>
          <h3 className="text-white font-bold text-lg mb-1">Build your rank system</h3>
          <p className="text-gray-500 text-sm mb-6 max-w-xs leading-relaxed">
            Start with a BJJ, Judo, or Karate preset — or build a custom progression from scratch.
          </p>
          {canManage && (
            <div className="flex gap-3">
              <button
                onClick={() => setPresetOpen(true)}
                className="px-5 py-2.5 rounded-xl border border-black/10 text-gray-300 text-sm font-semibold hover:text-white hover:border-white/20 transition-all"
              >
                Use Preset
              </button>
              <button
                onClick={openAdd}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-semibold transition-all"
                style={{ background: primaryColor }}
              >
                <Plus className="w-4 h-4" />
                Custom Rank
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Discipline tabs */}
          <div className="flex gap-2 mb-4 border-b border-black/8 pb-3 overflow-x-auto">
            {disciplines.map((d) => (
              <button
                key={d}
                onClick={() => setActiveTab(d)}
                className="px-4 py-1.5 rounded-full text-sm font-medium transition-all whitespace-nowrap"
                style={
                  currentTab === d
                    ? { background: primaryColor, color: "white" }
                    : { background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.5)" }
                }
              >
                {d}
              </button>
            ))}
          </div>

          {/* Ranks for selected discipline */}
          {currentTab && grouped.has(currentTab) && (
            <div className="space-y-2">
              {(grouped.get(currentTab) ?? []).map((rank, idx, arr) => (
                <RankCard
                  key={rank.id}
                  rank={rank}
                  onEdit={(r) => { setEditTarget(r); setDrawerOpen(true); }}
                  onDelete={handleDelete}
                  onMoveUp={(id) => handleMove(id, "up")}
                  onMoveDown={(id) => handleMove(id, "down")}
                  isFirst={idx === 0}
                  isLast={idx === arr.length - 1}
                  canManage={canManage}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Add/Edit drawer */}
      <Drawer
        open={drawerOpen}
        title={editTarget ? "Edit Rank" : "Add Rank"}
        onClose={() => setDrawerOpen(false)}
      >
        <RankForm
          initial={editTarget}
          disciplines={disciplines.length > 0 ? disciplines : ["BJJ"]}
          primaryColor={primaryColor}
          onSave={handleSave}
          onCancel={() => setDrawerOpen(false)}
          saving={saving}
        />
      </Drawer>

      {/* Preset picker */}
      <Drawer
        open={presetOpen}
        title="Choose a Preset"
        onClose={() => setPresetOpen(false)}
      >
        <div className="space-y-3">
          <p className="text-gray-500 text-sm">Select a martial art to auto-populate the rank system.</p>
          {Object.entries(PRESETS).map(([name, belts]) => (
            <button
              key={name}
              onClick={() => applyPreset(name)}
              disabled={saving}
              className="w-full text-left p-4 rounded-2xl border border-black/10 hover:border-black/12 transition-all"
              style={{ background: "rgba(255,255,255,0.025)" }}
            >
              <div className="flex items-center justify-between mb-2">
                <p className="text-white font-semibold text-sm">{name}</p>
                <span className="text-gray-600 text-xs">{belts.length} ranks</span>
              </div>
              <div className="flex gap-1.5">
                {belts.map((b) => (
                  <div
                    key={b.name}
                    className="w-6 h-3 rounded-sm"
                    style={{
                      background: b.color,
                      border: b.color === "#e5e7eb" ? "1px solid rgba(0,0,0,0.12)" : undefined,
                    }}
                    title={b.name}
                  />
                ))}
              </div>
            </button>
          ))}
        </div>
      </Drawer>
    </div>
  );
}
